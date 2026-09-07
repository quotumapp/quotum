import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { MerchantAuth } from "./auth";
import { SIGNUP_COOKIE } from "./auth";
import { merchantBillingRoute } from "./billing";
import type { MerchantMailer } from "./email";
import { MerchantOnboarding } from "./onboarding";
import {
	assertCsrf,
	CSRF_COOKIE,
	cookieValue,
	csrfCookie,
	idempotencyKey,
	MerchantError,
	normalizeEmail,
	randomToken,
	SESSION_COOKIE,
	sessionCookie,
} from "./security";
import { MerchantStepUp } from "./step-up";
import type { MerchantIdentity, MerchantStore } from "./store";
import { MerchantTeam } from "./team";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/);
const projectKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,62}$/);
const name = z.string().trim().min(2).max(100);
const token = z.string().min(16).max(4096);
const inviteRole = z.enum(["Admin", "Developer", "Operator", "Viewer"]);
const organization = z.object({ organizationSlug: slug });
const scopeSchema = z.strictObject({
	kind: z.literal("merchant"),
	organizationSlug: slug,
	projectKey,
	environment: z.enum(["sandbox", "production"]),
});
const INVITE_COOKIE = "__Host-quotum_invite";
export const MERCHANT_AUTH_POST_PATHS = new Set([
	"/sign-up/email",
	"/sign-in/email",
	"/sign-in/social",
	"/two-factor/send-otp",
	"/two-factor/verify-otp",
	"/send-verification-email",
	"/request-password-reset",
	"/reset-password",
]);
export interface MerchantAppDependencies {
	store: MerchantStore;
	mailer: MerchantMailer;
	auth: MerchantAuth;
	onboarding?: MerchantOnboarding;
	billing?: (request: Request, identity: MerchantIdentity) => Promise<Response>;
}

export async function merchantJson(request: Request): Promise<unknown> {
	if (!(request.headers.get("content-type") ?? "").startsWith("application/json"))
		throw new MerchantError("INVALID_REQUEST", "Send a JSON request.", 415);
	const reader = request.body?.getReader();
	let length = 0;
	const chunks: Uint8Array[] = [];
	if (reader)
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > 64 * 1024) {
				await reader.cancel();
				throw new MerchantError("REQUEST_TOO_LARGE", "The request is too large.", 413);
			}
			chunks.push(value);
		}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new MerchantError("INVALID_REQUEST", "Send a valid JSON request.");
	}
}
export function createMerchantApp({
	store,
	mailer,
	auth,
	onboarding = new MerchantOnboarding(store),
	billing,
}: MerchantAppDependencies) {
	const app = new Hono<{ Variables: { requestId: string } }>();
	const team = new MerchantTeam(store, mailer);
	const stepUp = new MerchantStepUp(store);
	const current = (request: Request) => store.authenticate(request);
	const invitationHash = async (request: Request, raw?: string) => {
		if (raw) return store.hash(raw);
		const intent = cookieValue(request.headers, INVITE_COOKIE);
		const payload = intent ? await store.readLink(intent, "invitation") : null;
		if (!payload || typeof payload.invitationHash !== "string")
			throw new MerchantError(
				"INVITATION_NOT_FOUND",
				"Open the invitation email to continue.",
				404,
			);
		return payload.invitationHash;
	};
	const transient = async (request: Request) => {
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session)
			throw new MerchantError(
				"AUTHENTICATION_INCOMPLETE",
				"Complete sign-in before continuing.",
				401,
			);
		return session.session.token;
	};
	app.onError((error, c) => {
		const failure =
			error instanceof MerchantError
				? error
				: error instanceof z.ZodError
					? new MerchantError("INVALID_REQUEST", "Check the form fields and try again.")
					: new MerchantError(
							"SERVICE_UNAVAILABLE",
							"We could not complete the request. Please try again.",
							503,
						);
		if (failure.retryAfter) c.header("retry-after", String(failure.retryAfter));
		return c.json(
			{
				success: false,
				error: {
					code: failure.code,
					message: failure.message,
					...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
					requestId: c.get("requestId"),
				},
			},
			failure.status as ContentfulStatusCode,
		);
	});
	app.use("*", async (c, next) => {
		const requestId = crypto.randomUUID();
		c.set("requestId", requestId);
		c.header("x-request-id", requestId);
		c.header("cache-control", "no-store");
		c.header("referrer-policy", "no-referrer");
		c.header("x-content-type-options", "nosniff");
		if (!store.config.enabled) throw new MerchantError("NOT_FOUND", "Route not found.", 404);
		if (!(await store.serviceAuthorized(c.req.header("x-quotum-service-token") ?? null)))
			throw new MerchantError("SERVICE_UNAUTHORIZED", "Request origin is not authorized.", 401);
		if (c.req.method !== "GET" && c.req.method !== "HEAD") {
			assertCsrf(c.req.raw, store.config.origin);
			idempotencyKey(c.req.raw);
		}
		await next();
	});
	app.get("/api/platform/config", (c) => {
		const existing = cookieValue(c.req.raw.headers, CSRF_COOKIE);
		const csrf = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomToken();
		c.header("set-cookie", csrfCookie(csrf), { append: true });
		return c.json({
			success: true,
			data: {
				csrfToken: csrf,
				signupEnabled: store.config.signupEnabled,
				googleEnabled: store.config.google !== null,
				termsVersion: store.config.termsVersion,
				privacyVersion: store.config.privacyVersion,
				publicUrl: store.config.publicUrl,
			},
		});
	});
	app.get("/api/platform/session", async (c) => {
		const identity = await current(c.req.raw);
		const csrf = cookieValue(c.req.raw.headers, CSRF_COOKIE) ?? "";
		const parsed = scopeSchema.safeParse({
			kind: "merchant",
			organizationSlug: c.req.header("x-quotum-organization"),
			projectKey: c.req.header("x-quotum-project"),
			environment: c.req.header("x-quotum-environment"),
		});
		const invite = cookieValue(c.req.raw.headers, INVITE_COOKIE);
		const pendingInvitation = Boolean(invite && (await store.readLink(invite, "invitation")));
		return c.json({
			success: true,
			data: {
				...(await store.view(identity, csrf, parsed.success ? parsed.data : null)),
				pendingInvitation,
			},
		});
	});
	app.post("/api/platform/signup-intent", async (c) => {
		if (!store.config.signupEnabled)
			throw new MerchantError("SIGNUP_DISABLED", "Registration is not available yet.", 403);
		const input = z
			.strictObject({
				accepted: z.literal(true),
				termsVersion: z.literal(store.config.termsVersion),
				privacyVersion: z.literal(store.config.privacyVersion),
			})
			.parse(await merchantJson(c.req.raw));
		await store.rateLimit(
			`signup-intent:${c.req.header("x-quotum-client-ip") ?? "unknown"}`,
			20,
			60 * 60_000,
		);
		const intent = randomToken();
		await store.registerLink(intent, "signup", 15 * 60_000, input);
		c.header(
			"set-cookie",
			`${SIGNUP_COOKIE}=${intent}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`,
			{ append: true },
		);
		return c.json({ success: true, data: { status: "accepted" } });
	});
	app.post("/api/platform/session/exchange", async (c) => {
		const result = await store.exchange(
			await transient(c.req.raw),
			cookieValue(c.req.raw.headers, SESSION_COOKIE),
		);
		c.header("set-cookie", sessionCookie(result.token), { append: true });
		c.header("set-cookie", csrfCookie(result.csrf), { append: true });
		clearTransientCookies(c);
		return c.json({ success: true, data: { status: "authenticated" } });
	});
	app.post("/api/platform/logout", async (c) => {
		const identity = await current(c.req.raw);
		await store.logout(identity);
		c.header("set-cookie", sessionCookie("", 0), { append: true });
		clearTransientCookies(c);
		return c.json({ success: true, data: { status: "signed_out" } });
	});
	app.post("/api/platform/verify-email", async (c) => {
		const input = z.strictObject({ token }).parse(await merchantJson(c.req.raw));
		await store.consumeLink(input.token, "verification");
		try {
			await auth.api.verifyEmail({ query: { token: input.token } });
		} catch {
			throw new MerchantError(
				"LINK_EXPIRED",
				"This verification link has expired. Request a new email.",
				410,
			);
		}
		return c.json({ success: true, data: { status: "verified" } });
	});
	app.all("/api/auth/*", async (c) => {
		const path = c.req.path.slice("/api/auth".length);
		if (c.req.method === "GET" && path === "/callback/google") return auth.handler(c.req.raw);
		if (c.req.method !== "POST" || !MERCHANT_AUTH_POST_PATHS.has(path))
			throw new MerchantError("NOT_FOUND", "Route not found.", 404);
		const input = z.record(z.string(), z.unknown()).parse(await merchantJson(c.req.raw));
		const ip = c.req.header("x-quotum-client-ip") ?? "unknown";
		if (typeof input.email === "string") input.email = normalizeEmail(input.email);
		if (path === "/sign-up/email") {
			if (!store.config.signupEnabled)
				throw new MerchantError("SIGNUP_DISABLED", "Registration is not available yet.", 403);
			await store.rateLimit(`signup:ip:${ip}`, 5, 60 * 60_000);
			await store.rateLimit(`signup:email:${input.email}`, 3, 24 * 60 * 60_000);
			const intent = cookieValue(c.req.raw.headers, SIGNUP_COOKIE);
			if (!intent || !(await store.readLink(intent, "signup")))
				throw new MerchantError(
					"POLICY_ACCEPTANCE_REQUIRED",
					"Accept the current terms and privacy policy first.",
				);
		}
		if (path === "/sign-in/email") {
			await store.rateLimit(`password:ip:${ip}`, 20, 15 * 60_000);
			await store.rateLimit(`password:account:${input.email}`, 5, 15 * 60_000);
		}
		if (path === "/request-password-reset" || path === "/send-verification-email") {
			await store.rateLimit(`${path}:ip:${ip}`, 20, 60 * 60_000);
			await store.rateLimit(`${path}:email:${input.email}`, 3, 60 * 60_000);
		}
		if (path === "/reset-password") {
			const reset = z.object({ token, newPassword: z.string().min(12).max(128) }).parse(input);
			await store.consumeLink(reset.token, "reset");
		}
		if (path === "/sign-in/social") {
			if (input.requestSignUp === true) {
				if (!store.config.signupEnabled)
					throw new MerchantError("SIGNUP_DISABLED", "Registration is not available yet.", 403);
				const intent = cookieValue(c.req.raw.headers, SIGNUP_COOKIE);
				if (!intent || !(await store.readLink(intent, "signup")))
					throw new MerchantError(
						"POLICY_ACCEPTANCE_REQUIRED",
						"Accept the current terms and privacy policy first.",
					);
				await store.rateLimit(`signup:ip:${ip}`, 5, 60 * 60_000);
			}
			for (const field of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"]) {
				if (input[field] !== undefined) {
					const url = new URL(String(input[field]), store.config.origin);
					if (
						url.origin !== store.config.origin ||
						!["/auth/callback", "/auth/error"].includes(url.pathname)
					)
						throw new MerchantError("RETURN_URL_REJECTED", "Choose a valid sign-in destination.");
				}
			}
		}
		const response = await auth.handler(
			new Request(c.req.url, {
				method: "POST",
				headers: c.req.raw.headers,
				body: JSON.stringify(input),
			}),
		);
		const headers = new Headers(response.headers);
		const payload: unknown = await response.json().catch(() => null);
		// The library's duplicate-email fast path is generic, but a concurrent insert
		// can hit its unique constraint instead. Preserve the same non-enumerating result.
		if (
			path === "/sign-up/email" &&
			response.status === 422 &&
			payload &&
			typeof payload === "object" &&
			"code" in payload &&
			payload.code === "FAILED_TO_CREATE_USER" &&
			typeof input.email === "string"
		) {
			const existing =
				await store.sql`SELECT id FROM platform_auth_users WHERE email=${input.email}`;
			if (existing.length)
				return new Response(JSON.stringify({ status: true }), { status: 200, headers });
		}
		if (path === "/sign-in/email" && response.ok) {
			await store.releaseRateLimit(`password:ip:${ip}`);
			await store.releaseRateLimit(`password:account:${input.email}`);
		}
		if (
			response.ok &&
			["/sign-up/email", "/request-password-reset", "/send-verification-email"].includes(path)
		)
			return new Response(JSON.stringify({ status: true }), { status: 200, headers });
		return new Response(JSON.stringify(redactAuthResponse(payload)), {
			status: response.status,
			headers,
		});
	});
	app.get("/api/platform/onboarding", async (c) =>
		c.json({ success: true, data: await store.draft((await current(c.req.raw)).principalId) }),
	);
	app.post("/api/platform/onboarding/organization", async (c) =>
		c.json({
			success: true,
			data: await onboarding.organization(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				z
					.strictObject({ name, slug, revision: z.number().int().positive().optional() })
					.parse(await merchantJson(c.req.raw)),
			),
		}),
	);
	app.post("/api/platform/onboarding/project", async (c) =>
		c.json({
			success: true,
			data: await onboarding.project(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				z
					.strictObject({ name, key: projectKey, revision: z.number().int().positive() })
					.parse(await merchantJson(c.req.raw)),
			),
		}),
	);
	app.post("/api/platform/onboarding/provision", async (c) =>
		c.json({
			success: true,
			data: await onboarding.start(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				z
					.strictObject({ revision: z.number().int().positive() })
					.parse(await merchantJson(c.req.raw)).revision,
			),
		}),
	);
	app.get("/api/platform/provisioning/:id", async (c) =>
		c.json({
			success: true,
			data: await onboarding.view(await current(c.req.raw), z.uuid().parse(c.req.param("id"))),
		}),
	);
	app.post("/api/platform/provisioning/:id/retry", async (c) =>
		c.json({
			success: true,
			data: await onboarding.resume(await current(c.req.raw), z.uuid().parse(c.req.param("id"))),
		}),
	);
	app.post("/api/platform/provisioning/:id/credential", async (c) =>
		c.json({
			success: true,
			data: await onboarding.credential(
				await current(c.req.raw),
				z.uuid().parse(c.req.param("id")),
				false,
				idempotencyKey(c.req.raw),
			),
		}),
	);
	app.post("/api/platform/provisioning/:id/rotate", async (c) =>
		c.json({
			success: true,
			data: await onboarding.credential(
				await current(c.req.raw),
				z.uuid().parse(c.req.param("id")),
				true,
				idempotencyKey(c.req.raw),
			),
		}),
	);
	app.post("/api/platform/invitations/preview", async (c) => {
		const input = z.strictObject({ token: token.optional() }).parse(await merchantJson(c.req.raw));
		let identity: MerchantIdentity | null = null;
		if (cookieValue(c.req.raw.headers, SESSION_COOKIE)) {
			try {
				identity = await current(c.req.raw);
			} catch (error) {
				if (!(error instanceof MerchantError) || error.status !== 401) throw error;
			}
		}
		const hash = await invitationHash(c.req.raw, input.token);
		const result = await team.preview(hash, identity, true);
		if (input.token) {
			const intent = randomToken();
			await store.registerLink(intent, "invitation", 60 * 60_000, { invitationHash: hash });
			c.header(
				"set-cookie",
				`${INVITE_COOKIE}=${intent}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
				{ append: true },
			);
		}
		return c.json({ success: true, data: result });
	});
	app.post("/api/platform/invitations/accept", async (c) => {
		const input = z.strictObject({ token: token.optional() }).parse(await merchantJson(c.req.raw));
		const result = await team.accept(
			await current(c.req.raw),
			idempotencyKey(c.req.raw),
			await invitationHash(c.req.raw, input.token),
			true,
		);
		c.header("set-cookie", `${INVITE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, {
			append: true,
		});
		return c.json({ success: true, data: result });
	});
	app.post("/api/platform/invitations/request", async (c) =>
		c.json({
			success: true,
			data: await team.requestReplacement(
				await invitationHash(
					c.req.raw,
					z.strictObject({ token: token.optional() }).parse(await merchantJson(c.req.raw)).token,
				),
				true,
			),
		}),
	);
	app.get("/api/platform/team", async (c) =>
		c.json({
			success: true,
			data: await team.list(
				await current(c.req.raw),
				slug.parse(new URL(c.req.url).searchParams.get("organization")),
			),
		}),
	);
	app.post("/api/platform/team/invitations", async (c) =>
		c.json({
			success: true,
			data: await team.invite(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				organization
					.extend({ email: z.email().transform(normalizeEmail), role: inviteRole })
					.strict()
					.parse(await merchantJson(c.req.raw)),
			),
		}),
	);
	app.post("/api/platform/team/invitations/:id/resend", async (c) => {
		const input = organization
			.extend({ role: inviteRole.optional() })
			.strict()
			.parse(await merchantJson(c.req.raw));
		return c.json({
			success: true,
			data: await team.resend(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				z.uuid().parse(c.req.param("id")),
				input.organizationSlug,
				input.role,
			),
		});
	});
	app.post("/api/platform/team/invitations/:id/revoke", async (c) =>
		c.json({
			success: true,
			data: await team.revoke(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				z.uuid().parse(c.req.param("id")),
				organization.strict().parse(await merchantJson(c.req.raw)).organizationSlug,
			),
		}),
	);
	app.post("/api/platform/team/members/:id", async (c) =>
		c.json({
			success: true,
			data: await team.updateMember(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				z.uuid().parse(c.req.param("id")),
				organization
					.extend({
						role: inviteRole.optional(),
						status: z.enum(["active", "suspended", "removed"]).optional(),
					})
					.strict()
					.refine((value) => value.role !== undefined || value.status !== undefined)
					.parse(await merchantJson(c.req.raw)),
			),
		}),
	);
	app.post("/api/platform/step-up", async (c) => {
		const input = z
			.strictObject({
				scope: scopeSchema,
				action: z.enum(["catalog.publish", "operations.recover", "operations.write"]),
				target: z
					.string()
					.max(1024)
					.regex(/^(POST|PUT|DELETE) \/api\/billing\/[^ ]+ [a-f0-9]{64}$/),
				returnTo: z.string().max(2048),
				request: z
					.strictObject({
						method: z.enum(["POST", "PUT", "DELETE"]),
						path: z.string().max(512),
						body: z.unknown(),
						idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
					})
					.optional(),
			})
			.parse(await merchantJson(c.req.raw));
		if (input.request) {
			const route = merchantBillingRoute(
				input.request.method,
				input.request.path,
				input.scope.environment,
			);
			if (!route || route.action !== input.action)
				throw new MerchantError(
					"ACTION_REJECTED",
					"Only the selected billing action can be saved for confirmation.",
				);
		}
		return c.json({
			success: true,
			data: await stepUp.create(await current(c.req.raw), idempotencyKey(c.req.raw), input),
		});
	});
	app.get("/api/platform/step-up/:id", async (c) =>
		c.json({
			success: true,
			data: await stepUp.view(await current(c.req.raw), z.uuid().parse(c.req.param("id"))),
		}),
	);
	app.post("/api/platform/step-up/:id/complete", async (c) => {
		const result = await stepUp.complete(
			await current(c.req.raw),
			z.uuid().parse(c.req.param("id")),
			await transient(c.req.raw),
		);
		c.header("set-cookie", sessionCookie(result.token), { append: true });
		c.header("set-cookie", csrfCookie(result.csrf), { append: true });
		clearTransientCookies(c);
		return c.json({ success: true, data: { grant: result.grant, expiresAt: result.expiresAt } });
	});
	app.all("/api/billing/*", async (c) => {
		if (!billing)
			throw new MerchantError("BILLING_UNAVAILABLE", "Billing is temporarily unavailable.", 503);
		return billing(c.req.raw, await current(c.req.raw));
	});
	app.notFound((c) =>
		c.json({ success: false, error: { code: "NOT_FOUND", message: "Route not found." } }, 404),
	);
	return app;
}

function redactAuthResponse(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactAuthResponse);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([key]) =>
					![
						"token",
						"accessToken",
						"refreshToken",
						"idToken",
						"password",
						"secret",
						"backupCodes",
					].includes(key),
			)
			.map(([key, item]) => [key, redactAuthResponse(item)]),
	);
}
function clearTransientCookies(c: {
	header(name: string, value: string, options?: { append: boolean }): void;
}) {
	for (const name of [
		"__Secure-quotum-auth.session_token",
		"__Secure-quotum-auth.two_factor",
		SIGNUP_COOKIE,
	])
		c.header("set-cookie", `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, {
			append: true,
		});
}
