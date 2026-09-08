import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { defineContract, registerRoute } from "../shared/http-contract";
import type { MerchantAuth } from "./auth";
import { SIGNUP_COOKIE } from "./auth";
import { merchantBillingRoute } from "./billing";
import type { MerchantMailer } from "./email";
import { MerchantOnboarding } from "./onboarding";
import * as responses from "./platform-responses";
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
export const resetPasswordBodySchema = z.object({
	token,
	newPassword: z.string().min(12).max(128),
});
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
	registerRoute(app, platformContracts.getApiPlatformConfig, (c) => {
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
	registerRoute(app, platformContracts.getApiPlatformSession, async (c) => {
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
	registerRoute(app, platformContracts.postApiPlatformSignupIntent, async (c) => {
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
	registerRoute(app, platformContracts.postApiPlatformSessionExchange, async (c) => {
		const result = await store.exchange(
			await transient(c.req.raw),
			cookieValue(c.req.raw.headers, SESSION_COOKIE),
		);
		c.header("set-cookie", sessionCookie(result.token), { append: true });
		c.header("set-cookie", csrfCookie(result.csrf), { append: true });
		clearTransientCookies(c);
		return c.json({ success: true, data: { status: "authenticated" } });
	});
	registerRoute(app, platformContracts.postApiPlatformLogout, async (c) => {
		const identity = await current(c.req.raw);
		await store.logout(identity);
		c.header("set-cookie", sessionCookie("", 0), { append: true });
		clearTransientCookies(c);
		return c.json({ success: true, data: { status: "signed_out" } });
	});
	registerRoute(app, platformContracts.postApiPlatformVerifyEmail, async (c) => {
		const input = postApiPlatformVerifyEmailBodySchema.parse(await merchantJson(c.req.raw));
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
			const reset = resetPasswordBodySchema.parse(input);
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
	registerRoute(app, platformContracts.getApiPlatformOnboarding, async (c) =>
		c.json({ success: true, data: await store.draft((await current(c.req.raw)).principalId) }),
	);
	registerRoute(app, platformContracts.postApiPlatformOnboardingOrganization, async (c) =>
		c.json({
			success: true,
			data: await onboarding.organization(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				postApiPlatformOnboardingOrganizationBodySchema.parse(await merchantJson(c.req.raw)),
			),
		}),
	);
	registerRoute(app, platformContracts.postApiPlatformOnboardingProject, async (c) =>
		c.json({
			success: true,
			data: await onboarding.project(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				postApiPlatformOnboardingProjectBodySchema.parse(await merchantJson(c.req.raw)),
			),
		}),
	);
	registerRoute(app, platformContracts.postApiPlatformOnboardingProvision, async (c) =>
		c.json({
			success: true,
			data: await onboarding.start(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				postApiPlatformOnboardingProvisionBodySchema.parse(await merchantJson(c.req.raw)).revision,
			),
		}),
	);
	registerRoute(app, platformContracts.getApiPlatformProvisioningById, async (c) =>
		c.json({
			success: true,
			data: await onboarding.view(await current(c.req.raw), z.uuid().parse(c.req.param("id"))),
		}),
	);
	registerRoute(app, platformContracts.postApiPlatformProvisioningByIdRetry, async (c) =>
		c.json({
			success: true,
			data: await onboarding.resume(await current(c.req.raw), z.uuid().parse(c.req.param("id"))),
		}),
	);
	registerRoute(app, platformContracts.postApiPlatformProvisioningByIdCredential, async (c) =>
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
	registerRoute(app, platformContracts.postApiPlatformProvisioningByIdRotate, async (c) =>
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
	registerRoute(app, platformContracts.postApiPlatformInvitationsPreview, async (c) => {
		const input = postApiPlatformInvitationsPreviewBodySchema.parse(await merchantJson(c.req.raw));
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
	registerRoute(app, platformContracts.postApiPlatformInvitationsAccept, async (c) => {
		const input = postApiPlatformInvitationsAcceptBodySchema.parse(await merchantJson(c.req.raw));
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
	registerRoute(app, platformContracts.postApiPlatformInvitationsRequest, async (c) =>
		c.json({
			success: true,
			data: await team.requestReplacement(
				await invitationHash(
					c.req.raw,
					postApiPlatformInvitationsRequestBodySchema.parse(await merchantJson(c.req.raw)).token,
				),
				true,
			),
		}),
	);
	registerRoute(app, platformContracts.getApiPlatformTeam, async (c) =>
		c.json({
			success: true,
			data: await team.list(
				await current(c.req.raw),
				slug.parse(new URL(c.req.url).searchParams.get("organization")),
			),
		}),
	);
	registerRoute(app, platformContracts.postApiPlatformTeamInvitations, async (c) =>
		c.json({
			success: true,
			data: await team.invite(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				postApiPlatformTeamInvitationsBodySchema.parse(await merchantJson(c.req.raw)),
			),
		}),
	);
	registerRoute(app, platformContracts.postApiPlatformTeamInvitationsByIdResend, async (c) => {
		const input = postApiPlatformTeamInvitationsByIdResendBodySchema.parse(
			await merchantJson(c.req.raw),
		);
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
	registerRoute(app, platformContracts.postApiPlatformTeamInvitationsByIdRevoke, async (c) =>
		c.json({
			success: true,
			data: await team.revoke(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				z.uuid().parse(c.req.param("id")),
				postApiPlatformTeamInvitationsByIdRevokeBodySchema.parse(await merchantJson(c.req.raw))
					.organizationSlug,
			),
		}),
	);
	registerRoute(app, platformContracts.postApiPlatformTeamMembersById, async (c) =>
		c.json({
			success: true,
			data: await team.updateMember(
				await current(c.req.raw),
				idempotencyKey(c.req.raw),
				z.uuid().parse(c.req.param("id")),
				postApiPlatformTeamMembersByIdBodySchema.parse(await merchantJson(c.req.raw)),
			),
		}),
	);
	registerRoute(app, platformContracts.postApiPlatformStepUp, async (c) => {
		const input = postApiPlatformStepUpBodySchema.parse(await merchantJson(c.req.raw));
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
	registerRoute(app, platformContracts.getApiPlatformStepUpById, async (c) =>
		c.json({
			success: true,
			data: await stepUp.view(await current(c.req.raw), z.uuid().parse(c.req.param("id"))),
		}),
	);
	registerRoute(app, platformContracts.postApiPlatformStepUpByIdComplete, async (c) => {
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

const postApiPlatformSignupIntentBodySchema = z.strictObject({
	accepted: z.literal(true),
	termsVersion: z.string(),
	privacyVersion: z.string(),
});
const postApiPlatformVerifyEmailBodySchema = z.strictObject({ token });
const postApiPlatformOnboardingOrganizationBodySchema = z.strictObject({
	name,
	slug,
	revision: z.number().int().positive().optional(),
});
const postApiPlatformOnboardingProjectBodySchema = z.strictObject({
	name,
	key: projectKey,
	revision: z.number().int().positive(),
});
const postApiPlatformOnboardingProvisionBodySchema = z.strictObject({
	revision: z.number().int().positive(),
});
const postApiPlatformInvitationsPreviewBodySchema = z.strictObject({ token: token.optional() });
const postApiPlatformInvitationsAcceptBodySchema = z.strictObject({ token: token.optional() });
const postApiPlatformInvitationsRequestBodySchema = z.strictObject({ token: token.optional() });
const postApiPlatformTeamInvitationsBodySchema = organization
	.extend({ email: z.email().transform(normalizeEmail), role: inviteRole })
	.strict();
const postApiPlatformTeamInvitationsByIdResendBodySchema = organization
	.extend({ role: inviteRole.optional() })
	.strict();
const postApiPlatformTeamInvitationsByIdRevokeBodySchema = organization.strict();
const postApiPlatformTeamMembersByIdBodySchema = organization
	.extend({
		role: inviteRole.optional(),
		status: z.enum(["active", "suspended", "removed"]).optional(),
	})
	.strict()
	.refine((value) => value.role !== undefined || value.status !== undefined);
const postApiPlatformStepUpBodySchema = z.strictObject({
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
});
export const platformContracts = {
	getApiPlatformConfig: defineContract("get", "/api/platform/config", {
		operationId: "getApiPlatformConfig",
		tags: ["platform"],
		responses: { "200": responses.getApiPlatformConfigResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string().optional(),
			"Idempotency-Key": z.string().optional(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	getApiPlatformSession: defineContract("get", "/api/platform/session", {
		operationId: "getApiPlatformSession",
		tags: ["platform"],
		responses: { "200": responses.getApiPlatformSessionResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string().optional(),
			"Idempotency-Key": z.string().optional(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformSignupIntent: defineContract("post", "/api/platform/signup-intent", {
		operationId: "postApiPlatformSignupIntent",
		tags: ["platform"],
		body: postApiPlatformSignupIntentBodySchema,
		responses: { "200": responses.postApiPlatformSignupIntentResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformSessionExchange: defineContract("post", "/api/platform/session/exchange", {
		operationId: "postApiPlatformSessionExchange",
		tags: ["platform"],
		body: z.object({}).loose(),
		responses: { "200": responses.postApiPlatformSessionExchangeResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformLogout: defineContract("post", "/api/platform/logout", {
		operationId: "postApiPlatformLogout",
		tags: ["platform"],
		body: z.object({}).loose(),
		responses: { "200": responses.postApiPlatformLogoutResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformVerifyEmail: defineContract("post", "/api/platform/verify-email", {
		operationId: "postApiPlatformVerifyEmail",
		tags: ["platform"],
		body: postApiPlatformVerifyEmailBodySchema,
		responses: { "200": responses.postApiPlatformVerifyEmailResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	getApiPlatformOnboarding: defineContract("get", "/api/platform/onboarding", {
		operationId: "getApiPlatformOnboarding",
		tags: ["platform"],
		responses: { "200": responses.getApiPlatformOnboardingResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string().optional(),
			"Idempotency-Key": z.string().optional(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformOnboardingOrganization: defineContract(
		"post",
		"/api/platform/onboarding/organization",
		{
			operationId: "postApiPlatformOnboardingOrganization",
			tags: ["platform"],
			body: postApiPlatformOnboardingOrganizationBodySchema,
			responses: { "200": responses.postApiPlatformOnboardingOrganizationResponse200Schema },
			headers: z.object({
				"X-CSRF-Token": z.string(),
				"Idempotency-Key": z.string(),
				"X-Quotum-Step-Up-Grant": z.string().optional(),
			}),
		},
	),
	postApiPlatformOnboardingProject: defineContract("post", "/api/platform/onboarding/project", {
		operationId: "postApiPlatformOnboardingProject",
		tags: ["platform"],
		body: postApiPlatformOnboardingProjectBodySchema,
		responses: { "200": responses.postApiPlatformOnboardingProjectResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformOnboardingProvision: defineContract("post", "/api/platform/onboarding/provision", {
		operationId: "postApiPlatformOnboardingProvision",
		tags: ["platform"],
		body: postApiPlatformOnboardingProvisionBodySchema,
		responses: { "200": responses.postApiPlatformOnboardingProvisionResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	getApiPlatformProvisioningById: defineContract("get", "/api/platform/provisioning/:id", {
		operationId: "getApiPlatformProvisioningById",
		tags: ["platform"],
		params: z.object({ id: z.uuid() }),
		responses: { "200": responses.getApiPlatformProvisioningByIdResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string().optional(),
			"Idempotency-Key": z.string().optional(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformProvisioningByIdRetry: defineContract(
		"post",
		"/api/platform/provisioning/:id/retry",
		{
			operationId: "postApiPlatformProvisioningByIdRetry",
			tags: ["platform"],
			params: z.object({ id: z.uuid() }),
			body: z.object({}).loose(),
			responses: { "200": responses.postApiPlatformProvisioningByIdRetryResponse200Schema },
			headers: z.object({
				"X-CSRF-Token": z.string(),
				"Idempotency-Key": z.string(),
				"X-Quotum-Step-Up-Grant": z.string().optional(),
			}),
		},
	),
	postApiPlatformProvisioningByIdCredential: defineContract(
		"post",
		"/api/platform/provisioning/:id/credential",
		{
			operationId: "postApiPlatformProvisioningByIdCredential",
			tags: ["platform"],
			params: z.object({ id: z.uuid() }),
			body: z.object({}).loose(),
			responses: { "200": responses.postApiPlatformProvisioningByIdCredentialResponse200Schema },
			headers: z.object({
				"X-CSRF-Token": z.string(),
				"Idempotency-Key": z.string(),
				"X-Quotum-Step-Up-Grant": z.string().optional(),
			}),
		},
	),
	postApiPlatformProvisioningByIdRotate: defineContract(
		"post",
		"/api/platform/provisioning/:id/rotate",
		{
			operationId: "postApiPlatformProvisioningByIdRotate",
			tags: ["platform"],
			params: z.object({ id: z.uuid() }),
			body: z.object({}).loose(),
			responses: { "200": responses.postApiPlatformProvisioningByIdRotateResponse200Schema },
			headers: z.object({
				"X-CSRF-Token": z.string(),
				"Idempotency-Key": z.string(),
				"X-Quotum-Step-Up-Grant": z.string().optional(),
			}),
		},
	),
	postApiPlatformInvitationsPreview: defineContract("post", "/api/platform/invitations/preview", {
		operationId: "postApiPlatformInvitationsPreview",
		tags: ["platform"],
		body: postApiPlatformInvitationsPreviewBodySchema,
		responses: { "200": responses.postApiPlatformInvitationsPreviewResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformInvitationsAccept: defineContract("post", "/api/platform/invitations/accept", {
		operationId: "postApiPlatformInvitationsAccept",
		tags: ["platform"],
		body: postApiPlatformInvitationsAcceptBodySchema,
		responses: { "200": responses.postApiPlatformInvitationsAcceptResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformInvitationsRequest: defineContract("post", "/api/platform/invitations/request", {
		operationId: "postApiPlatformInvitationsRequest",
		tags: ["platform"],
		body: postApiPlatformInvitationsRequestBodySchema,
		responses: { "200": responses.postApiPlatformInvitationsRequestResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	getApiPlatformTeam: defineContract("get", "/api/platform/team", {
		operationId: "getApiPlatformTeam",
		tags: ["platform"],
		query: z.object({ organization: slug }),
		responses: { "200": responses.getApiPlatformTeamResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string().optional(),
			"Idempotency-Key": z.string().optional(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformTeamInvitations: defineContract("post", "/api/platform/team/invitations", {
		operationId: "postApiPlatformTeamInvitations",
		tags: ["platform"],
		body: postApiPlatformTeamInvitationsBodySchema,
		responses: { "200": responses.postApiPlatformTeamInvitationsResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformTeamInvitationsByIdResend: defineContract(
		"post",
		"/api/platform/team/invitations/:id/resend",
		{
			operationId: "postApiPlatformTeamInvitationsByIdResend",
			tags: ["platform"],
			body: postApiPlatformTeamInvitationsByIdResendBodySchema,
			params: z.object({ id: z.uuid() }),
			responses: { "200": responses.postApiPlatformTeamInvitationsByIdResendResponse200Schema },
			headers: z.object({
				"X-CSRF-Token": z.string(),
				"Idempotency-Key": z.string(),
				"X-Quotum-Step-Up-Grant": z.string().optional(),
			}),
		},
	),
	postApiPlatformTeamInvitationsByIdRevoke: defineContract(
		"post",
		"/api/platform/team/invitations/:id/revoke",
		{
			operationId: "postApiPlatformTeamInvitationsByIdRevoke",
			tags: ["platform"],
			body: postApiPlatformTeamInvitationsByIdRevokeBodySchema,
			params: z.object({ id: z.uuid() }),
			responses: { "200": responses.postApiPlatformTeamInvitationsByIdRevokeResponse200Schema },
			headers: z.object({
				"X-CSRF-Token": z.string(),
				"Idempotency-Key": z.string(),
				"X-Quotum-Step-Up-Grant": z.string().optional(),
			}),
		},
	),
	postApiPlatformTeamMembersById: defineContract("post", "/api/platform/team/members/:id", {
		operationId: "postApiPlatformTeamMembersById",
		tags: ["platform"],
		body: postApiPlatformTeamMembersByIdBodySchema,
		params: z.object({ id: z.uuid() }),
		responses: { "200": responses.postApiPlatformTeamMembersByIdResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformStepUp: defineContract("post", "/api/platform/step-up", {
		operationId: "postApiPlatformStepUp",
		tags: ["platform"],
		body: postApiPlatformStepUpBodySchema,
		responses: { "200": responses.postApiPlatformStepUpResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	getApiPlatformStepUpById: defineContract("get", "/api/platform/step-up/:id", {
		operationId: "getApiPlatformStepUpById",
		tags: ["platform"],
		params: z.object({ id: z.uuid() }),
		responses: { "200": responses.getApiPlatformStepUpByIdResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string().optional(),
			"Idempotency-Key": z.string().optional(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
	postApiPlatformStepUpByIdComplete: defineContract("post", "/api/platform/step-up/:id/complete", {
		operationId: "postApiPlatformStepUpByIdComplete",
		tags: ["platform"],
		params: z.object({ id: z.uuid() }),
		body: z.object({}).loose(),
		responses: { "200": responses.postApiPlatformStepUpByIdCompleteResponse200Schema },
		headers: z.object({
			"X-CSRF-Token": z.string(),
			"Idempotency-Key": z.string(),
			"X-Quotum-Step-Up-Grant": z.string().optional(),
		}),
	}),
} as const;
