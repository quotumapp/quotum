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
		const transport = Object.assign(async () => new Response("provider-secret", { status: 401 }), {
			preconnect: fetch.preconnect,
		});
		const mailer = new CloudflareMerchantMailer(
			{ accountId: "test", apiToken: "secret", from: "auth@quotum.dev" },
			transport,
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
		).rejects.toThrow("We could not send the email");
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
