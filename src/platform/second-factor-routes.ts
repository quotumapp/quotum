import type { Elysia } from "elysia";
import { z } from "zod";
import { operationDetail } from "../shared/http";
import { ACCOUNT_ISSUERS, type MerchantAuth } from "./auth";
import { SecondFactorEnrolmentViewSchema, SecondFactorRecoveryCodesViewSchema } from "./schemas";
import { MERCHANT_JSON_PARSE, MerchantError } from "./security";
import type { MerchantIdentity, MerchantStore } from "./store";

/** How long an emailed code keeps the right to set up an authenticator. */
const BOOTSTRAP_MS = 10 * 60_000;
/** How fresh a Google sign-in must be to set up an authenticator on a live session. */
const FRESH_PROOF_MS = 5 * 60_000;

const startBody = z.strictObject({ code: z.string().min(1).max(32).optional() });
const codeBody = z.strictObject({ code: z.string().min(1).max(32) });
const success = (data: z.ZodType) => z.object({ success: z.literal(true), data });

/**
 * Who is setting up or changing an authenticator, and how they proved it:
 * - `bootstrap`: a password sign-in whose emailed code proved the mailbox, with no session yet;
 * - `member`: a signed-in person, who proved it with a current code or a fresh Google sign-in.
 * A session cookie alone never qualifies, or a stolen cookie could enrol the thief's authenticator.
 */
type Actor =
	| { kind: "bootstrap"; userId: string; email: string; sessionId: string }
	| {
			kind: "member";
			userId: string;
			email: string;
			principalId: string;
	  };

interface TransientRow {
	auth_method: string | null;
	auth_issuer: string | null;
	auth_subject: string | null;
	proof_at: Date | null;
	bootstrap_at: Date | null;
	mcp_request_hash: string | null;
}

export function registerSecondFactorRoutes(app: Elysia, store: MerchantStore, auth: MerchantAuth) {
	const factor = auth.secondFactor;
	const bootstrapRequired = () =>
		new MerchantError(
			"SECOND_FACTOR_BOOTSTRAP_REQUIRED",
			"Sign in again to set up your authenticator app.",
			403,
		);
	const transient = async (request: Request) => {
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session) return null;
		const [row] = await store.sql<
			TransientRow[]
		>`SELECT auth_method,auth_issuer,auth_subject,proof_at,bootstrap_at,mcp_request_hash FROM platform_auth_sessions WHERE id=${session.session.id} AND expires_at>${store.now()}`;
		return row
			? { ...row, id: session.session.id, userId: session.user.id, email: session.user.email }
			: null;
	};
	const bootstrapActor = async (request: Request): Promise<Actor | null> => {
		const proof = await transient(request);
		if (!proof || proof.auth_method !== null || !proof.bootstrap_at) return null;
		if (proof.bootstrap_at.getTime() < store.now().getTime() - BOOTSTRAP_MS) return null;
		// Emailed codes are refused once an authenticator exists; this is the same rule at the data.
		if (await factor.isEnrolled(proof.userId)) return null;
		return { kind: "bootstrap", userId: proof.userId, email: proof.email, sessionId: proof.id };
	};
	const memberOf = (identity: MerchantIdentity): Actor => ({
		kind: "member",
		userId: identity.authUserId,
		email: identity.email,
		principalId: identity.principalId,
	});
	const startActor = async (request: Request, code: string | undefined): Promise<Actor> => {
		const bootstrap = await bootstrapActor(request);
		if (bootstrap) return bootstrap;
		const identity = await store.authenticate(request);
		const actor = memberOf(identity);
		if ((await factor.status(identity.authUserId)).enrolled) {
			if (!code)
				throw new MerchantError(
					"CODE_REQUIRED",
					"Enter a code shown in your current authenticator to replace it.",
				);
			await factor.verifyCode(identity.authUserId, code);
			return actor;
		}
		if (identity.authMethod !== "google") throw bootstrapRequired();
		const proof = await transient(request);
		if (
			!proof ||
			proof.userId !== identity.authUserId ||
			proof.auth_method !== "google" ||
			proof.auth_issuer !== identity.issuer ||
			proof.auth_subject !== identity.subject ||
			proof.mcp_request_hash !== null ||
			!proof.proof_at ||
			proof.proof_at.getTime() < store.now().getTime() - FRESH_PROOF_MS
		)
			throw new MerchantError(
				"FRESH_SIGN_IN_REQUIRED",
				"Sign in with Google again to set up your authenticator app.",
				403,
			);
		return actor;
	};
	const confirmActor = async (request: Request): Promise<Actor> => {
		const bootstrap = await bootstrapActor(request);
		if (bootstrap) return bootstrap;
		const identity = await store.authenticate(request);
		// A password session that never enrolled cannot finish what an earlier proof started.
		if (identity.authMethod !== "google" && !(await factor.status(identity.authUserId)).enrolled)
			throw bootstrapRequired();
		return memberOf(identity);
	};
	const principalFor = async (userId: string): Promise<string | null> => {
		const [row] = await store.sql<
			{ id: string }[]
		>`SELECT id FROM platform_principals WHERE auth_user_id=${userId}`;
		return row?.id ?? null;
	};

	app.post(
		"/api/platform/second-factor/enrolment",
		async ({ request, body }) => {
			const input = startBody.parse(body);
			const actor = await startActor(request, input.code);
			return {
				success: true as const,
				data: await factor.beginEnrolment({ id: actor.userId, email: actor.email }),
			};
		},
		{
			parse: [MERCHANT_JSON_PARSE],
			body: startBody,
			detail: operationDetail({
				operationId: "postApiPlatformSecondFactorEnrolment",
				tags: ["platform"],
				path: "/api/platform/second-factor/enrolment",
				responses: { 200: success(SecondFactorEnrolmentViewSchema) },
			}),
		},
	);

	app.post(
		"/api/platform/second-factor/enrolment/confirm",
		async ({ request, body }) => {
			const input = codeBody.parse(body);
			const actor = await confirmActor(request);
			const principalId =
				actor.kind === "member" ? actor.principalId : await principalFor(actor.userId);
			const { recoveryCodes } = await factor.confirmEnrolment(
				actor.userId,
				input.code,
				async (tx, info) => {
					if (actor.kind === "bootstrap") {
						// The authenticator code is the proof that completes the password sign-in the emailed
						// code started; only now does the session become exchangeable.
						const [account] = await tx<
							{ account_id: string }[]
						>`SELECT account_id FROM platform_auth_accounts WHERE user_id=${actor.userId} AND provider_id='credential'`;
						if (!account)
							throw new MerchantError("IDENTITY_MISSING", "Sign in again to continue.", 401);
						await tx`UPDATE platform_auth_sessions SET auth_method='password',auth_issuer=${ACCOUNT_ISSUERS.credential},auth_subject=${account.account_id},proof_at=${store.now()} WHERE id=${actor.sessionId}`;
					}
					await store.audit(
						tx,
						principalId,
						null,
						info.replaced ? "second_factor.replaced" : "second_factor.enrolled",
						actor.userId,
						{ via: actor.kind },
					);
				},
			);
			return { success: true as const, data: { recoveryCodes } };
		},
		{
			parse: [MERCHANT_JSON_PARSE],
			body: codeBody,
			detail: operationDetail({
				operationId: "postApiPlatformSecondFactorEnrolmentConfirm",
				tags: ["platform"],
				path: "/api/platform/second-factor/enrolment/confirm",
				responses: { 200: success(SecondFactorRecoveryCodesViewSchema) },
			}),
		},
	);

	app.post(
		"/api/platform/second-factor/recovery-codes",
		async ({ request, body }) => {
			const input = codeBody.parse(body);
			const identity = await store.authenticate(request);
			// A code is spent to prove it is the person; the old set is replaced as a whole.
			await factor.verifyCode(identity.authUserId, input.code);
			const recoveryCodes = await factor.regenerateRecoveryCodes(identity.authUserId);
			await store.audit(
				store.sql,
				identity.principalId,
				null,
				"second_factor.recovery_codes_regenerated",
				identity.authUserId,
			);
			return { success: true as const, data: { recoveryCodes } };
		},
		{
			parse: [MERCHANT_JSON_PARSE],
			body: codeBody,
			detail: operationDetail({
				operationId: "postApiPlatformSecondFactorRecoveryCodes",
				tags: ["platform"],
				path: "/api/platform/second-factor/recovery-codes",
				responses: { 200: success(SecondFactorRecoveryCodesViewSchema) },
			}),
		},
	);
}
