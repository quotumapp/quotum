import { describe, expect, it } from "bun:test";
import { createMerchantApp } from "../../src/platform/app";
import { createMerchantAuth } from "../../src/platform/auth";
import type { MerchantConfig } from "../../src/platform/config";
import { CSRF_COOKIE } from "../../src/platform/security";
import { MerchantStore } from "../../src/platform/store";

const config: MerchantConfig = {
	signupEnabled: true,
	origin: "https://merchant.example.test",
	publicUrl: "https://quotum.example.test",
	secret: "merchant-http-unit-test-secret-at-least-32-characters",
	termsVersion: "current",
	privacyVersion: "current",
	google: null,
	email: null,
	testMode: true,
};

const unavailable = async (): Promise<never> => {
	throw new Error("unexpected persistence access");
};

/** Only the service-principal lookup is answered; any other query fails the test loudly. */
function merchantApp() {
	const sql = Object.assign(
		(strings: TemplateStringsArray) =>
			strings.join("?").includes("platform_service_principals")
				? Promise.resolve([{ id: "service-principal" }])
				: unavailable(),
		{ begin: unavailable },
	);
	const store = new MerchantStore(sql as never, config);
	const mailer = { send: unavailable };
	return createMerchantApp({ store, mailer, auth: createMerchantAuth(store, mailer, undefined) });
}

const csrf = "c".repeat(43);

function mutation(path: string, init: { headers?: Record<string, string>; body?: BodyInit }) {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: {
			origin: config.origin,
			cookie: `${CSRF_COOKIE}=${csrf}`,
			"x-csrf-token": csrf,
			"x-quotum-service-token": "service-token",
			"idempotency-key": "merchant-http-test",
			...init.headers,
		},
		body: init.body,
	});
}

describe("merchant request bodies", () => {
	it("keeps the 415 rule for non-JSON bodies", async () => {
		const response = await merchantApp().handle(
			mutation("/api/platform/signup-intent", {
				headers: { "content-type": "text/plain" },
				body: "{}",
			}),
		);

		expect(response.status).toBe(415);
		expect(await response.json()).toMatchObject({
			success: false,
			error: { code: "INVALID_REQUEST", message: "Send a JSON request." },
		});
	});

	it("keeps the 64 KB cap", async () => {
		const response = await merchantApp().handle(
			mutation("/api/platform/signup-intent", {
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
			}),
		);

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			success: false,
			error: { code: "REQUEST_TOO_LARGE" },
		});
	});

	it("does not require a body on operations that never read one", async () => {
		const app = merchantApp();
		for (const path of [
			"/api/platform/logout",
			"/api/platform/provisioning/00000000-0000-4000-8000-000000000001/retry",
			"/api/platform/provisioning/00000000-0000-4000-8000-000000000001/credential",
			"/api/platform/provisioning/00000000-0000-4000-8000-000000000001/rotate",
			"/api/platform/step-up/00000000-0000-4000-8000-000000000001/complete",
		]) {
			const response = await app.handle(mutation(path, {}));

			// No session cookie: the handler runs and asks for a session instead of a JSON body.
			expect(response.status, path).toBe(401);
			expect(await response.json(), path).toMatchObject({ error: { code: "SESSION_REQUIRED" } });
		}
	});
});
