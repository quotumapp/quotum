import { describe, expect, it } from "bun:test";
import { CloudflareMerchantMailer, escapeHtml, linkMessage } from "../../src/platform/email";

describe("merchant email transport", () => {
	it("sends REST field names and retries bounded transient failures", async () => {
		const requests: Request[] = [];
		const waits: number[] = [];
		const transport = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				requests.push(new Request(input, init));
				return requests.length === 1
					? new Response("retry", { status: 429, headers: { "retry-after": "1" } })
					: Response.json({
							success: true,
							result: { delivered: ["person@example.com"], permanent_bounces: [] },
						});
			},
			{ preconnect: fetch.preconnect },
		);
		const mailer = new CloudflareMerchantMailer(
			{ accountId: "synthetic-account", apiToken: "synthetic-token", from: "auth@quotum.dev" },
			transport,
			async (ms) => {
				waits.push(ms);
			},
		);
		await mailer.send(
			linkMessage(
				"person@example.com",
				"verification",
				"Verify email",
				"https://app.quotum.dev/verify-email#token=synthetic",
			),
		);
		expect(requests).toHaveLength(2);
		expect(waits).toEqual([1000]);
		expect(await requests[0]?.json()).toMatchObject({
			from: { address: "auth@quotum.dev", name: "Quotum" },
			to: "person@example.com",
		});
	});
	it("sanitizes provider failures instead of exposing credentials or response bodies", async () => {
		const requests: Request[] = [];
		const waits: number[] = [];
		const transport = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				requests.push(new Request(input, init));
				return new Response("provider-secret", { status: 401 });
			},
			{ preconnect: fetch.preconnect },
		);
		const mailer = new CloudflareMerchantMailer(
			{ accountId: "test", apiToken: "synthetic-api-token", from: "auth@quotum.dev" },
			transport,
			async (ms) => {
				waits.push(ms);
			},
		);
		let captured: unknown;
		try {
			await mailer.send(
				linkMessage(
					"person@example.com",
					"reset",
					"Reset",
					"https://app.quotum.dev/reset-password",
				),
			);
		} catch (error) {
			captured = error;
		}
		expect(captured).toMatchObject({
			message: "We could not send the email. Please try again.",
			code: "EMAIL_DELIVERY_FAILED",
			status: 503,
		});
		expect(String(captured)).not.toContain("synthetic-api-token");
		expect(String(captured)).not.toContain("provider-secret");
		expect(requests).toHaveLength(1);
		expect(waits).toEqual([]);
	});

	it("retries three times on 429 then sanitizes the failure", async () => {
		const requests: Request[] = [];
		const waits: number[] = [];
		const transport = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				requests.push(new Request(input, init));
				return new Response("retry", { status: 429, headers: { "retry-after": "1" } });
			},
			{ preconnect: fetch.preconnect },
		);
		const mailer = new CloudflareMerchantMailer(
			{ accountId: "test", apiToken: "synthetic-api-token", from: "auth@quotum.dev" },
			transport,
			async (ms) => {
				waits.push(ms);
			},
		);
		await expect(
			mailer.send(
				linkMessage(
					"person@example.com",
					"reset",
					"Reset",
					"https://app.quotum.dev/reset-password",
				),
			),
		).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED", status: 503 });
		expect(requests).toHaveLength(3);
		expect(waits).toEqual([1000, 1000]);
	});

	it("backs off 5xx responses without retry-after and caps retry-after", async () => {
		const waits: number[] = [];
		const transport = Object.assign(
			async () => {
				if (waits.length < 2) {
					return new Response("busy", { status: 503 });
				}
				return Response.json({
					success: true,
					result: { delivered: ["person@example.com"], permanent_bounces: [] },
				});
			},
			{ preconnect: fetch.preconnect },
		);
		const mailer = new CloudflareMerchantMailer(
			{ accountId: "test", apiToken: "token", from: "auth@quotum.dev" },
			transport,
			async (ms) => {
				waits.push(ms);
			},
		);
		await mailer.send(
			linkMessage("person@example.com", "reset", "Reset", "https://app.quotum.dev/reset-password"),
		);
		expect(waits).toEqual([250, 500]);

		const capped: number[] = [];
		const cappedMailer = new CloudflareMerchantMailer(
			{ accountId: "test", apiToken: "token", from: "auth@quotum.dev" },
			Object.assign(
				async () => new Response("later", { status: 429, headers: { "retry-after": "60" } }),
				{
					preconnect: fetch.preconnect,
				},
			),
			async (ms) => {
				capped.push(ms);
			},
		);
		await expect(
			cappedMailer.send(
				linkMessage(
					"person@example.com",
					"reset",
					"Reset",
					"https://app.quotum.dev/reset-password",
				),
			),
		).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
		expect(capped[0]).toBe(5000);

		const invalid: number[] = [];
		const invalidMailer = new CloudflareMerchantMailer(
			{ accountId: "test", apiToken: "token", from: "auth@quotum.dev" },
			Object.assign(
				async () => new Response("later", { status: 429, headers: { "retry-after": "soon" } }),
				{ preconnect: fetch.preconnect },
			),
			async (ms) => {
				invalid.push(ms);
			},
		);
		await expect(
			invalidMailer.send(
				linkMessage(
					"person@example.com",
					"reset",
					"Reset",
					"https://app.quotum.dev/reset-password",
				),
			),
		).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
		expect(invalid[0]).toBe(250);
	});

	it("sanitizes transport throws, bounces, and unsuccessful 200 payloads after one request", async () => {
		const transports: Array<typeof fetch> = [
			Object.assign(
				async () => {
					throw new Error("socket hang up");
				},
				{ preconnect: fetch.preconnect },
			),
			Object.assign(
				async () =>
					Response.json({
						success: true,
						result: { delivered: [], permanent_bounces: ["person@example.com"] },
					}),
				{ preconnect: fetch.preconnect },
			),
			Object.assign(async () => Response.json({ success: false }), {
				preconnect: fetch.preconnect,
			}),
		];
		for (const transport of transports) {
			const requests: Request[] = [];
			const wrapped = Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					requests.push(new Request(input, init));
					return await transport(input, init);
				},
				{ preconnect: fetch.preconnect },
			);
			const mailer = new CloudflareMerchantMailer(
				{ accountId: "test", apiToken: "token", from: "auth@quotum.dev" },
				wrapped,
			);
			await expect(
				mailer.send(
					linkMessage(
						"person@example.com",
						"reset",
						"Reset",
						"https://app.quotum.dev/reset-password",
					),
				),
			).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED", status: 503 });
			expect(requests).toHaveLength(1);
		}
	});
	it("escapes user-controlled organization names in HTML messages", () => {
		expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
			"&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
		);
		expect(
			linkMessage(
				"person@example.com",
				"invitation",
				"Join <script>",
				"https://app.quotum.dev/invite",
			).html,
		).not.toContain("<script>");
	});
});
