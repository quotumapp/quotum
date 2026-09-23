import { describe, expect, it } from "bun:test";
import { createMerchantApp } from "../../src/platform/app";
import type { MerchantBillingCommand } from "../../src/platform/application/billing-port";
import { createMerchantAuth } from "../../src/platform/auth";
import { createMerchantBilling } from "../../src/platform/billing";
import type { MerchantConfig } from "../../src/platform/config";
import { CSRF_COOKIE } from "../../src/platform/security";
import { type MerchantIdentity, MerchantStore } from "../../src/platform/store";

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
function merchantApp(options: Partial<Parameters<typeof createMerchantApp>[0]> = {}) {
	const sql = Object.assign(
		(strings: TemplateStringsArray) =>
			strings.join("?").includes("platform_service_principals")
				? Promise.resolve([{ id: "service-principal" }])
				: unavailable(),
		{ begin: unavailable },
	);
	const store = new MerchantStore(sql as never, config);
	const mailer = { send: unavailable };
	return createMerchantApp({
		store,
		mailer,
		auth: createMerchantAuth(store, mailer, undefined),
		...options,
	});
}

function getRequest(path: string, headers: Record<string, string> = {}) {
	return new Request(`http://localhost${path}`, {
		headers: {
			"x-quotum-service-token": "service-token",
			...headers,
		},
	});
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

describe("merchant observability hooks", () => {
	it("runs request observability middleware for merchant routes", async () => {
		let middlewareRan = false;
		const app = merchantApp({
			requestObservabilityMiddleware: (inner) =>
				inner.onRequest(() => {
					middlewareRan = true;
				}),
		});

		const response = await app.handle(getRequest("/api/platform/config"));

		expect(response.status).toBe(200);
		expect(middlewareRan).toBe(true);
	});

	it("reports merchant 5xx with route pattern and request id", async () => {
		const reports: Array<{ error: unknown; report: Record<string, unknown> }> = [];
		const app = merchantApp({
			onUnexpectedError: (error, report) => {
				reports.push({ error, report: report as unknown as Record<string, unknown> });
			},
		});

		const response = await app.handle(
			getRequest("/api/platform/session", {
				cookie: "__Host-quotum_session=session-token-for-503",
			}),
		);
		const body = (await response.json()) as {
			error: { code: string; requestId?: string };
		};

		expect(response.status).toBe(503);
		expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
		expect(reports).toHaveLength(1);
		const report = reports[0]?.report as {
			route: string;
			status: number;
			code: string;
			requestId: string | undefined;
		};
		expect(report.route).toBe("/api/platform/session");
		expect(report.status).toBe(503);
		expect(report.code).toBe("SERVICE_UNAVAILABLE");
		expect(report.requestId).toBe(body.error.requestId);
		expect(response.headers.get("x-request-id")).toBe(body.error.requestId ?? null);
	});

	it("does not report 401 404 or 415", async () => {
		const reports: unknown[] = [];
		const app = merchantApp({
			onUnexpectedError: (error, report) => {
				reports.push({ error, report });
			},
		});

		const unauthorized = await app.handle(new Request("http://localhost/api/platform/session"));
		expect(unauthorized.status).toBe(401);

		const notFound = await app.handle(getRequest("/api/platform/does-not-exist"));
		expect(notFound.status).toBe(404);

		const unsupported = await app.handle(
			mutation("/api/platform/signup-intent", {
				headers: { "content-type": "text/plain" },
				body: "{}",
			}),
		);
		expect(unsupported.status).toBe(415);

		expect(reports).toEqual([]);
	});

	it("keeps the 503 envelope when the reporter throws", async () => {
		const app = merchantApp({
			onUnexpectedError: () => {
				throw new Error("reporter boom");
			},
		});

		const response = await app.handle(
			getRequest("/api/platform/session", {
				cookie: "__Host-quotum_session=session-token-for-503",
			}),
		);
		const body = (await response.json()) as { error: { code: string } };

		expect(response.status).toBe(503);
		expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
	});
});

describe("merchant billing proxy paths", () => {
	/** A signed-in store whose only reachable query is the service-principal lookup. */
	function proxyApp(reports: string[], dispatched: MerchantBillingCommand[]) {
		const sql = Object.assign(
			(strings: TemplateStringsArray) =>
				strings.join("?").includes("platform_service_principals")
					? Promise.resolve([{ id: "service-principal" }])
					: unavailable(),
			{ begin: unavailable, query: unavailable },
		);
		class SignedInStore extends MerchantStore {
			override async authenticate(): Promise<MerchantIdentity> {
				return {
					principalId: "principal-1",
					authUserId: "user-1",
					sessionId: "session-1",
					name: "Viewer",
					email: "viewer@example.test",
					authMethod: "password",
					issuer: "quotum",
					subject: "user-1",
					createdAt: new Date(),
					lastSeenAt: new Date(),
					absoluteExpiresAt: new Date(Date.now() + 3_600_000),
				};
			}
		}
		const store = new SignedInStore(sql as never, config);
		const mailer = { send: unavailable };
		return createMerchantApp({
			store,
			mailer,
			auth: createMerchantAuth(store, mailer, undefined),
			billing: createMerchantBilling(store, {
				dispatch: async (command) => {
					dispatched.push(command);
					return { status: 200, body: { success: true, data: null } };
				},
			}),
			onUnexpectedError: (_error, report) => reports.push(`${report.status} ${report.code}`),
		});
	}
	const scope = {
		"x-quotum-organization": "acme",
		"x-quotum-project": "example",
		"x-quotum-environment": "sandbox",
	};

	it("answers a malformed escape as /v1 does, before any lookup or step-up", async () => {
		const reports: string[] = [];
		const dispatched: MerchantBillingCommand[] = [];
		const app = proxyApp(reports, dispatched);

		const read = await app.handle(
			getRequest("/api/billing/admin/billing-accounts/%E0%A4%A/billing-summary", scope),
		);
		const write = await app.handle(
			mutation("/api/billing/admin/billing-accounts/%E0%A4%A/commercial-actions", {
				headers: { ...scope, "content-type": "application/json" },
				body: JSON.stringify({ previewToken: "a".repeat(64) }),
			}),
		);

		for (const response of [read, write]) {
			expect(response.status).toBe(400);
			expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
				"INVALID_REQUEST",
			);
		}
		expect(dispatched).toEqual([]);
		expect(reports).toEqual([]);
	});
});
