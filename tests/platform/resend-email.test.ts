import { describe, expect, it, spyOn } from "bun:test";
import { createMerchantMailer, linkMessage } from "../../src/platform/email";

const config = {
	provider: "resend" as const,
	apiKey: "synthetic-resend-key",
	from: "auth@example.com",
};
const message = linkMessage(
	"person@example.com",
	"verification",
	"Verify your email",
	"https://app.example.com/verify-email#token=synthetic",
);

function fixture(respond: (request: Request, attempt: number) => Response | Promise<Response>) {
	const requests: Request[] = [];
	const waits: number[] = [];
	const transport = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push(request);
			return respond(request, requests.length);
		},
		{ preconnect: fetch.preconnect },
	);
	return {
		requests,
		waits,
		transport,
		mailer: createMerchantMailer(config, transport, async (ms) => {
			waits.push(ms);
		}),
	};
}

describe("Resend platform email", () => {
	it("selects Resend, preserves message contents and bounds each request", async () => {
		const timeout = spyOn(AbortSignal, "timeout");
		try {
			const f = fixture(() => Response.json({ id: "email-id" }));
			await f.mailer.send(message);
			const request = f.requests[0];
			expect(request?.url).toBe("https://api.resend.com/emails");
			expect(request?.method).toBe("POST");
			expect(request?.headers.get("authorization")).toBe(`Bearer ${config.apiKey}`);
			expect(request?.headers.get("content-type")).toBe("application/json");
			expect(await request?.json()).toEqual({
				from: "Quotum <auth@example.com>",
				to: [message.to],
				subject: message.subject,
				text: message.text,
				html: message.html,
			});
			expect(timeout).toHaveBeenCalledWith(10_000);
			expect(f.waits).toEqual([]);
		} finally {
			timeout.mockRestore();
		}
	});
	it("keeps Cloudflare selectable through the same factory", async () => {
		const f = fixture(() => Response.json({ success: true, result: { permanent_bounces: [] } }));
		await createMerchantMailer(
			{ provider: "cloudflare", accountId: "account", apiToken: "token", from: config.from },
			f.transport,
		).send(message);
		expect(f.requests[0]?.url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/account/email/sending/send",
		);
		expect(await f.requests[0]?.json()).toMatchObject({
			from: { address: config.from, name: "Quotum" },
		});
	});
	it("reuses one idempotency key and payload for retries, with a new key for the next send", async () => {
		const f = fixture((_request, attempt) =>
			attempt < 3 ? new Response("busy", { status: 503 }) : Response.json({ id: "accepted" }),
		);
		await f.mailer.send(message);
		expect(f.waits).toEqual([250, 500]);
		const keys = f.requests.map((r) => r.headers.get("idempotency-key"));
		expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(new Set(keys).size).toBe(1);
		expect(new Set(await Promise.all(f.requests.map((r) => r.text()))).size).toBe(1);
		await f.mailer.send(message);
		expect(f.requests[3]?.headers.get("idempotency-key")).not.toBe(keys[0]);
	});
	for (const [retryAfter, expected] of [
		["1", 1000],
		["60", 5000],
		["invalid", 250],
	] as const) {
		it(`bounds retries with Retry-After=${retryAfter}`, async () => {
			const f = fixture(
				() => new Response("private-body", { status: 429, headers: { "retry-after": retryAfter } }),
			);
			await expect(f.mailer.send(message)).rejects.toMatchObject({
				code: "EMAIL_DELIVERY_FAILED",
				status: 503,
			});
			expect(f.requests).toHaveLength(3);
			expect(f.waits).toHaveLength(2);
			expect(f.waits[0]).toBe(expected);
		});
	}
	for (const [name, respond] of [
		["authentication", () => new Response("private-body", { status: 401 })],
		["validation", () => new Response("private-body", { status: 422 })],
		["conflict", () => new Response("private-body", { status: 409 })],
		["invalid JSON", () => new Response("private-body")],
		["missing ID", () => Response.json({ success: true })],
		["empty ID", () => Response.json({ id: " " })],
		["invalid ID", () => Response.json({ id: 42 })],
		[
			"network",
			() => {
				throw new Error("private-transport-error");
			},
		],
		[
			"timeout",
			() => {
				throw new DOMException("private-timeout", "TimeoutError");
			},
		],
	] as const) {
		it(`sanitizes ${name} failures without retrying`, async () => {
			const f = fixture(respond);
			let error: unknown;
			try {
				await f.mailer.send(message);
			} catch (caught) {
				error = caught;
			}
			expect(error).toMatchObject({
				code: "EMAIL_DELIVERY_FAILED",
				status: 503,
				message: "We could not send the email. Please try again.",
			});
			expect(String(error)).not.toContain("private-");
			expect(String(error)).not.toContain(config.apiKey);
			expect(f.requests).toHaveLength(1);
			expect(f.waits).toEqual([]);
		});
	}
});
