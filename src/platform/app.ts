import { Elysia } from "elysia";
import { z } from "zod";
import { readCappedText } from "../shared/body-limit";
import { type ElysiaPluginLike, HTTP_APP_CONFIG, operationDetail } from "../shared/http";
import type { MerchantAuth } from "./auth";
import { SIGNUP_COOKIE } from "./auth";
import { merchantBillingRoute } from "./billing";
import type { MerchantStripeOAuth } from "./connections/oauth";
import { registerConnectionRoutes } from "./connections/routes";
import type { MerchantConnections } from "./connections/service";
import type { MerchantMailer } from "./email";
import { MerchantOnboarding } from "./onboarding";
import * as responses from "./platform-responses";
import {
	assertCsrf,
	CSRF_COOKIE,
	cookieValue,
	csrfCookie,
	idempotencyKey,
	MERCHANT_JSON_PARSE,
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
export interface MerchantUnexpectedErrorReport {
	request: Request;
	requestId: string | undefined;
	route: string | undefined;
	status: number;
	code: string;
}
export interface MerchantAppDependencies {
	store: MerchantStore;
	connections?: MerchantConnections;
	stripeOAuth?: MerchantStripeOAuth;
	mailer: MerchantMailer;
	auth: MerchantAuth;
	onboarding?: MerchantOnboarding;
	billing?: (request: Request, identity: MerchantIdentity) => Promise<Response>;
	requestObservabilityMiddleware?: ElysiaPluginLike;
	onUnexpectedError?: (error: unknown, report: MerchantUnexpectedErrorReport) => void;
}

const MERCHANT_MAX_BODY_BYTES = 64 * 1024;

export async function merchantJson(request: Request): Promise<unknown> {
	if (!(request.headers.get("content-type") ?? "").startsWith("application/json"))
		throw new MerchantError("INVALID_REQUEST", "Send a JSON request.", 415);
	const text = await readCappedText(request, MERCHANT_MAX_BODY_BYTES, tooLarge);
	try {
		return JSON.parse(text);
	} catch {
		throw new MerchantError("INVALID_REQUEST", "Send a valid JSON request.");
	}
}

function tooLarge(): MerchantError {
	return new MerchantError("REQUEST_TOO_LARGE", "The request is too large.", 413);
}

function appendSetCookie(set: { headers: Record<string, unknown> }, value: string): void {
	const existing = set.headers["set-cookie"];
	if (existing === undefined) {
		set.headers["set-cookie"] = value;
		return;
	}
	set.headers["set-cookie"] = [
		...(Array.isArray(existing) ? existing : [existing as string]),
		value,
	];
}

function clearTransientCookies(set: { headers: Record<string, unknown> }): void {
	for (const name of [
		"__Secure-quotum-auth.session_token",
		"__Secure-quotum-auth.two_factor",
		SIGNUP_COOKIE,
	])
		appendSetCookie(set, `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

/** Documented body for mutations that accept, but never read, a JSON object. */
const unreadBodySchema = z.looseObject({});

const requestIds = new WeakMap<Request, string>();

export function createMerchantApp({
	store,
	mailer,
	auth,
	onboarding = new MerchantOnboarding(store),
	connections,
	stripeOAuth,
	billing,
	requestObservabilityMiddleware,
	onUnexpectedError,
}: MerchantAppDependencies) {
	const app = new Elysia(HTTP_APP_CONFIG);
	if (requestObservabilityMiddleware !== undefined) {
		app.use(requestObservabilityMiddleware);
	}
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

	app.parser("merchantJson", ({ request }: { request: Request }) => merchantJson(request));

	app.onError(({ request, error, set, code, route }) => {
		// Elysia wraps anything a parser throws in a ParseError; merchantJson's own 413 and 415
		// errors must surface unchanged, so unwrap the cause before the generic mappings.
		const cause = code === "PARSE" ? (error as { cause?: unknown }).cause : error;
		const failure =
			cause instanceof MerchantError
				? cause
				: code === "VALIDATION" || code === "PARSE" || cause instanceof z.ZodError
					? new MerchantError("INVALID_REQUEST", "Check the form fields and try again.")
					: code === "NOT_FOUND"
						? new MerchantError("NOT_FOUND", "Route not found.", 404)
						: new MerchantError(
								"SERVICE_UNAVAILABLE",
								"We could not complete the request. Please try again.",
								503,
							);
		if (failure.retryAfter !== undefined) set.headers["retry-after"] = String(failure.retryAfter);
		const requestId = requestIds.get(request);
		if (failure.status >= 500 && onUnexpectedError) {
			try {
				onUnexpectedError(cause, {
					request,
					requestId,
					route,
					status: failure.status,
					code: failure.code,
				});
			} catch {
				// Observability must not alter merchant behavior.
			}
		}
		set.status = failure.status;
		return {
			success: false as const,
			error: {
				code: failure.code,
				message: failure.message,
				...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }),
				...(requestId === undefined ? {} : { requestId }),
			},
		};
	});

	app.onRequest(async ({ request, set }) => {
		const requestId = crypto.randomUUID();
		requestIds.set(request, requestId);
		set.headers["x-request-id"] = requestId;
		set.headers["cache-control"] = "no-store";
		set.headers["referrer-policy"] = "no-referrer";
		set.headers["x-content-type-options"] = "nosniff";
		if (!(await store.serviceAuthorized(request.headers.get("x-quotum-service-token") ?? null)))
			throw new MerchantError("SERVICE_UNAUTHORIZED", "Request origin is not authorized.", 401);
		if (request.method !== "GET" && request.method !== "HEAD") {
			assertCsrf(request, store.config.origin);
			idempotencyKey(request);
		}
	});

	/** `body` documents the JSON a handler parses itself; merchant handlers validate inline. */
	const route = (
		operationId: string,
		path: string,
		responsesMap: Record<string, z.ZodType>,
		extra: { params?: z.ZodObject; query?: z.ZodObject; body?: z.ZodType } = {},
	) => ({
		...(extra.params === undefined ? {} : { params: extra.params }),
		...(extra.query === undefined ? {} : { query: extra.query }),
		detail: operationDetail({
			operationId,
			tags: ["platform"],
			path,
			responses: responsesMap,
			...(extra.body === undefined ? {} : { request: { body: extra.body } }),
		}),
	});

	app.get(
		"/api/platform/config",
		({ request, set }) => {
			const existing = cookieValue(request.headers, CSRF_COOKIE);
			const csrf = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomToken();
			appendSetCookie(set, csrfCookie(csrf));
			return {
				success: true as const,
				data: {
					csrfToken: csrf,
					signupEnabled: store.config.signupEnabled,
					googleEnabled: store.config.google !== null,
					termsVersion: store.config.termsVersion,
					privacyVersion: store.config.privacyVersion,
					publicUrl: store.config.publicUrl,
				},
			};
		},
		route("getApiPlatformConfig", "/api/platform/config", {
			200: responses.getApiPlatformConfigResponse200Schema,
		}),
	);

	app.get(
		"/api/platform/session",
		async ({ request }) => {
			const identity = await current(request);
			const csrf = cookieValue(request.headers, CSRF_COOKIE) ?? "";
			const parsed = scopeSchema.safeParse({
				kind: "merchant",
				organizationSlug: request.headers.get("x-quotum-organization"),
				projectKey: request.headers.get("x-quotum-project"),
				environment: request.headers.get("x-quotum-environment"),
			});
			const invite = cookieValue(request.headers, INVITE_COOKIE);
			const pendingInvitation = Boolean(invite && (await store.readLink(invite, "invitation")));
			return {
				success: true as const,
				data: {
					...(await store.view(identity, csrf, parsed.success ? parsed.data : null)),
					pendingInvitation,
				},
			};
		},
		route("getApiPlatformSession", "/api/platform/session", {
			200: responses.getApiPlatformSessionResponse200Schema,
		}),
	);

	app.post(
		"/api/platform/signup-intent",
		async ({ body, request, set }) => {
			if (!store.config.signupEnabled)
				throw new MerchantError("SIGNUP_DISABLED", "Registration is not available yet.", 403);
			const input = z
				.strictObject({
					accepted: z.literal(true),
					termsVersion: z.literal(store.config.termsVersion),
					privacyVersion: z.literal(store.config.privacyVersion),
				})
				.parse(body);
			await store.rateLimit(
				`signup-intent:${request.headers.get("x-quotum-client-ip") ?? "unknown"}`,
				20,
				60 * 60_000,
			);
			const intent = randomToken();
			await store.registerLink(intent, "signup", 15 * 60_000, input);
			appendSetCookie(
				set,
				`${SIGNUP_COOKIE}=${intent}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`,
			);
			return { success: true as const, data: { status: "accepted" } };
		},
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformSignupIntent",
				"/api/platform/signup-intent",
				{
					200: responses.postApiPlatformSignupIntentResponse200Schema,
				},
				{ body: postApiPlatformSignupIntentBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/session/exchange",
		async ({ request, set }) => {
			const result = await store.exchange(
				await transient(request),
				cookieValue(request.headers, SESSION_COOKIE),
			);
			appendSetCookie(set, sessionCookie(result.token));
			appendSetCookie(set, csrfCookie(result.csrf));
			clearTransientCookies(set);
			return { success: true as const, data: { status: "authenticated" } };
		},
		{
			// This operation never reads a request body.
			parse: "none",
			...route(
				"postApiPlatformSessionExchange",
				"/api/platform/session/exchange",
				{
					200: responses.postApiPlatformSessionExchangeResponse200Schema,
				},
				{ body: unreadBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/logout",
		async ({ request, set }) => {
			const identity = await current(request);
			await store.logout(identity);
			appendSetCookie(set, sessionCookie("", 0));
			clearTransientCookies(set);
			return { success: true as const, data: { status: "signed_out" } };
		},
		{
			// This operation never reads a request body.
			parse: "none",
			...route(
				"postApiPlatformLogout",
				"/api/platform/logout",
				{
					200: responses.postApiPlatformLogoutResponse200Schema,
				},
				{ body: unreadBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/verify-email",
		async ({ body }) => {
			const input = postApiPlatformVerifyEmailBodySchema.parse(body);
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
			return { success: true as const, data: { status: "verified" } };
		},
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformVerifyEmail",
				"/api/platform/verify-email",
				{
					200: responses.postApiPlatformVerifyEmailResponse200Schema,
				},
				{ body: postApiPlatformVerifyEmailBodySchema },
			),
		},
	);

	app.all("/api/auth/*", async ({ request }) => handleMerchantAuth(request), { parse: "none" });

	app.get(
		"/api/platform/onboarding",
		async ({ request }) => ({
			success: true as const,
			data: await store.draft((await current(request)).principalId),
		}),
		route("getApiPlatformOnboarding", "/api/platform/onboarding", {
			200: responses.getApiPlatformOnboardingResponse200Schema,
		}),
	);

	app.post(
		"/api/platform/onboarding/organization",
		async ({ body, request }) => ({
			success: true as const,
			data: await onboarding.organization(
				await current(request),
				idempotencyKey(request),
				postApiPlatformOnboardingOrganizationBodySchema.parse(body),
			),
		}),
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformOnboardingOrganization",
				"/api/platform/onboarding/organization",
				{
					200: responses.postApiPlatformOnboardingOrganizationResponse200Schema,
				},
				{ body: postApiPlatformOnboardingOrganizationBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/onboarding/project",
		async ({ body, request }) => ({
			success: true as const,
			data: await onboarding.project(
				await current(request),
				idempotencyKey(request),
				postApiPlatformOnboardingProjectBodySchema.parse(body),
			),
		}),
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformOnboardingProject",
				"/api/platform/onboarding/project",
				{
					200: responses.postApiPlatformOnboardingProjectResponse200Schema,
				},
				{ body: postApiPlatformOnboardingProjectBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/onboarding/provision",
		async ({ body, request }) => ({
			success: true as const,
			data: await onboarding.start(
				await current(request),
				idempotencyKey(request),
				postApiPlatformOnboardingProvisionBodySchema.parse(body).revision,
			),
		}),
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformOnboardingProvision",
				"/api/platform/onboarding/provision",
				{
					200: responses.postApiPlatformOnboardingProvisionResponse200Schema,
				},
				{ body: postApiPlatformOnboardingProvisionBodySchema },
			),
		},
	);

	app.get(
		"/api/platform/provisioning/:id",
		async ({ params, request }) => ({
			success: true as const,
			data: await onboarding.view(await current(request), z.uuid().parse(params.id)),
		}),
		route(
			"getApiPlatformProvisioningById",
			"/api/platform/provisioning/:id",
			{ 200: responses.getApiPlatformProvisioningByIdResponse200Schema },
			{ params: z.object({ id: z.uuid() }) },
		),
	);

	app.post(
		"/api/platform/provisioning/:id/retry",
		async ({ params, request }) => ({
			success: true as const,
			data: await onboarding.resume(await current(request), z.uuid().parse(params.id)),
		}),
		{
			// This operation never reads a request body.
			parse: "none",
			...route(
				"postApiPlatformProvisioningByIdRetry",
				"/api/platform/provisioning/:id/retry",
				{ 200: responses.postApiPlatformProvisioningByIdRetryResponse200Schema },
				{ params: z.object({ id: z.uuid() }), body: unreadBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/provisioning/:id/credential",
		async ({ params, request }) => ({
			success: true as const,
			data: await onboarding.credential(
				await current(request),
				z.uuid().parse(params.id),
				false,
				idempotencyKey(request),
			),
		}),
		{
			// This operation never reads a request body.
			parse: "none",
			...route(
				"postApiPlatformProvisioningByIdCredential",
				"/api/platform/provisioning/:id/credential",
				{ 200: responses.postApiPlatformProvisioningByIdCredentialResponse200Schema },
				{ params: z.object({ id: z.uuid() }), body: unreadBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/provisioning/:id/rotate",
		async ({ params, request }) => ({
			success: true as const,
			data: await onboarding.credential(
				await current(request),
				z.uuid().parse(params.id),
				true,
				idempotencyKey(request),
			),
		}),
		{
			// This operation never reads a request body.
			parse: "none",
			...route(
				"postApiPlatformProvisioningByIdRotate",
				"/api/platform/provisioning/:id/rotate",
				{ 200: responses.postApiPlatformProvisioningByIdRotateResponse200Schema },
				{ params: z.object({ id: z.uuid() }), body: unreadBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/invitations/preview",
		async ({ body, request, set }) => {
			const input = postApiPlatformInvitationsPreviewBodySchema.parse(body);
			let identity: MerchantIdentity | null = null;
			if (cookieValue(request.headers, SESSION_COOKIE)) {
				try {
					identity = await current(request);
				} catch (error) {
					if (!(error instanceof MerchantError) || error.status !== 401) throw error;
				}
			}
			const hash = await invitationHash(request, input.token);
			const result = await team.preview(hash, identity, true);
			if (input.token) {
				const intent = randomToken();
				await store.registerLink(intent, "invitation", 60 * 60_000, { invitationHash: hash });
				appendSetCookie(
					set,
					`${INVITE_COOKIE}=${intent}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
				);
			}
			return { success: true as const, data: result };
		},
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformInvitationsPreview",
				"/api/platform/invitations/preview",
				{
					200: responses.postApiPlatformInvitationsPreviewResponse200Schema,
				},
				{ body: postApiPlatformInvitationsPreviewBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/invitations/accept",
		async ({ body, request, set }) => {
			const input = postApiPlatformInvitationsAcceptBodySchema.parse(body);
			const result = await team.accept(
				await current(request),
				idempotencyKey(request),
				await invitationHash(request, input.token),
				true,
			);
			appendSetCookie(set, `${INVITE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
			return { success: true as const, data: result };
		},
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformInvitationsAccept",
				"/api/platform/invitations/accept",
				{
					200: responses.postApiPlatformInvitationsAcceptResponse200Schema,
				},
				{ body: postApiPlatformInvitationsAcceptBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/invitations/request",
		async ({ body, request }) => ({
			success: true as const,
			data: await team.requestReplacement(
				await invitationHash(
					request,
					postApiPlatformInvitationsRequestBodySchema.parse(body).token,
				),
				true,
			),
		}),
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformInvitationsRequest",
				"/api/platform/invitations/request",
				{
					200: responses.postApiPlatformInvitationsRequestResponse200Schema,
				},
				{ body: postApiPlatformInvitationsRequestBodySchema },
			),
		},
	);

	app.get(
		"/api/platform/team",
		async ({ request }) => ({
			success: true as const,
			data: await team.list(
				await current(request),
				slug.parse(new URL(request.url).searchParams.get("organization")),
			),
		}),
		route(
			"getApiPlatformTeam",
			"/api/platform/team",
			{ 200: responses.getApiPlatformTeamResponse200Schema },
			{ query: z.object({ organization: slug }) },
		),
	);

	app.post(
		"/api/platform/team/invitations",
		async ({ body, request }) => ({
			success: true as const,
			data: await team.invite(
				await current(request),
				idempotencyKey(request),
				postApiPlatformTeamInvitationsBodySchema.parse(body),
			),
		}),
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformTeamInvitations",
				"/api/platform/team/invitations",
				{
					200: responses.postApiPlatformTeamInvitationsResponse200Schema,
				},
				{ body: postApiPlatformTeamInvitationsBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/team/invitations/:id/resend",
		async ({ body, params, request }) => {
			const input = postApiPlatformTeamInvitationsByIdResendBodySchema.parse(body);
			return {
				success: true as const,
				data: await team.resend(
					await current(request),
					idempotencyKey(request),
					z.uuid().parse(params.id),
					input.organizationSlug,
					input.role,
				),
			};
		},
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformTeamInvitationsByIdResend",
				"/api/platform/team/invitations/:id/resend",
				{ 200: responses.postApiPlatformTeamInvitationsByIdResendResponse200Schema },
				{
					params: z.object({ id: z.uuid() }),
					body: postApiPlatformTeamInvitationsByIdResendBodySchema,
				},
			),
		},
	);

	app.post(
		"/api/platform/team/invitations/:id/revoke",
		async ({ body, params, request }) => ({
			success: true as const,
			data: await team.revoke(
				await current(request),
				idempotencyKey(request),
				z.uuid().parse(params.id),
				postApiPlatformTeamInvitationsByIdRevokeBodySchema.parse(body).organizationSlug,
			),
		}),
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformTeamInvitationsByIdRevoke",
				"/api/platform/team/invitations/:id/revoke",
				{ 200: responses.postApiPlatformTeamInvitationsByIdRevokeResponse200Schema },
				{
					params: z.object({ id: z.uuid() }),
					body: postApiPlatformTeamInvitationsByIdRevokeBodySchema,
				},
			),
		},
	);

	app.post(
		"/api/platform/team/members/:id",
		async ({ body, params, request }) => ({
			success: true as const,
			data: await team.updateMember(
				await current(request),
				idempotencyKey(request),
				z.uuid().parse(params.id),
				postApiPlatformTeamMembersByIdBodySchema.parse(body),
			),
		}),
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformTeamMembersById",
				"/api/platform/team/members/:id",
				{ 200: responses.postApiPlatformTeamMembersByIdResponse200Schema },
				{ params: z.object({ id: z.uuid() }), body: postApiPlatformTeamMembersByIdBodySchema },
			),
		},
	);

	app.post(
		"/api/platform/step-up",
		async ({ body, request }) => {
			const input = postApiPlatformStepUpBodySchema.parse(body);
			if (input.request) {
				const billingRoute = merchantBillingRoute(
					input.request.method,
					input.request.path,
					input.scope.environment,
				);
				if (!billingRoute || billingRoute.action !== input.action)
					throw new MerchantError(
						"ACTION_REJECTED",
						"Only the selected billing action can be saved for confirmation.",
					);
			}
			return {
				success: true as const,
				data: await stepUp.create(await current(request), idempotencyKey(request), input),
			};
		},
		{
			parse: [MERCHANT_JSON_PARSE],
			...route(
				"postApiPlatformStepUp",
				"/api/platform/step-up",
				{
					200: responses.postApiPlatformStepUpResponse200Schema,
				},
				{ body: postApiPlatformStepUpBodySchema },
			),
		},
	);

	app.get(
		"/api/platform/step-up/:id",
		async ({ params, request }) => ({
			success: true as const,
			data: await stepUp.view(await current(request), z.uuid().parse(params.id)),
		}),
		route(
			"getApiPlatformStepUpById",
			"/api/platform/step-up/:id",
			{ 200: responses.getApiPlatformStepUpByIdResponse200Schema },
			{ params: z.object({ id: z.uuid() }) },
		),
	);

	app.post(
		"/api/platform/step-up/:id/complete",
		async ({ params, request, set }) => {
			const result = await stepUp.complete(
				await current(request),
				z.uuid().parse(params.id),
				await transient(request),
			);
			appendSetCookie(set, sessionCookie(result.token));
			appendSetCookie(set, csrfCookie(result.csrf));
			clearTransientCookies(set);
			return {
				success: true as const,
				data: { grant: result.grant, expiresAt: result.expiresAt },
			};
		},
		{
			// This operation never reads a request body.
			parse: "none",
			...route(
				"postApiPlatformStepUpByIdComplete",
				"/api/platform/step-up/:id/complete",
				{ 200: responses.postApiPlatformStepUpByIdCompleteResponse200Schema },
				{ params: z.object({ id: z.uuid() }), body: unreadBodySchema },
			),
		},
	);

	app.all(
		"/api/billing/*",
		async ({ request }) => {
			if (!billing)
				throw new MerchantError("BILLING_UNAVAILABLE", "Billing is temporarily unavailable.", 503);
			return billing(request, await current(request));
		},
		{ parse: "none" },
	);

	if (connections) registerConnectionRoutes(app, store, connections, stripeOAuth);

	return app;

	async function handleMerchantAuth(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname.slice("/api/auth".length);
		if (request.method === "GET" && path === "/callback/google") return auth.handler(request);
		if (request.method !== "POST" || !MERCHANT_AUTH_POST_PATHS.has(path))
			throw new MerchantError("NOT_FOUND", "Route not found.", 404);
		const input = z.record(z.string(), z.unknown()).parse(await merchantJson(request));
		const ip = request.headers.get("x-quotum-client-ip") ?? "unknown";
		if (typeof input.email === "string") input.email = normalizeEmail(input.email);
		if (path === "/sign-up/email") {
			if (!store.config.signupEnabled)
				throw new MerchantError("SIGNUP_DISABLED", "Registration is not available yet.", 403);
			await store.rateLimit(`signup:ip:${ip}`, 5, 60 * 60_000);
			await store.rateLimit(`signup:email:${String(input.email)}`, 3, 24 * 60 * 60_000);
			const intent = cookieValue(request.headers, SIGNUP_COOKIE);
			if (!intent || !(await store.readLink(intent, "signup")))
				throw new MerchantError(
					"POLICY_ACCEPTANCE_REQUIRED",
					"Accept the current terms and privacy policy first.",
				);
		}
		if (path === "/sign-in/email") {
			await store.rateLimit(`password:ip:${ip}`, 20, 15 * 60_000);
			await store.rateLimit(`password:account:${String(input.email)}`, 5, 15 * 60_000);
		}
		if (path === "/request-password-reset" || path === "/send-verification-email") {
			await store.rateLimit(`${path}:ip:${ip}`, 20, 60 * 60_000);
			await store.rateLimit(`${path}:email:${String(input.email)}`, 3, 60 * 60_000);
		}
		if (path === "/reset-password") {
			const reset = resetPasswordBodySchema.parse(input);
			await store.consumeLink(reset.token, "reset");
		}
		if (path === "/sign-in/social") {
			if (input.requestSignUp === true) {
				if (!store.config.signupEnabled)
					throw new MerchantError("SIGNUP_DISABLED", "Registration is not available yet.", 403);
				const intent = cookieValue(request.headers, SIGNUP_COOKIE);
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
			new Request(request.url, {
				method: "POST",
				headers: request.headers,
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
			await store.releaseRateLimit(`password:account:${String(input.email)}`);
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
	}
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
	action: z.enum([
		"catalog.publish",
		"operations.recover",
		"operations.write",
		"connections.manage",
		"environment.activate",
		"credentials.rotate",
	]),
	target: z.string().max(1024).min(1),
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
