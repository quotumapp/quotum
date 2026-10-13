import { AsyncLocalStorage } from "node:async_hooks";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins/two-factor";
import { verifyGoogleIdToken } from "better-auth/social-providers";
import { toDisplayName } from "../shared/input-bounds";
import type { MerchantEmail, MerchantMailer } from "./email";
import { linkMessage, securityNotice } from "./email";
import { createMcpAuthProvider } from "./mcp/auth-provider";
import { McpAuthorizations } from "./mcp/authorization";
import {
	lockedError,
	MerchantSecondFactor,
	RECOVERY_CODE_COUNT,
	replayedCode,
	SECOND_FACTOR_LOCK_SECONDS,
	SECOND_FACTOR_MAX_FAILURES,
	type SecretSealer,
	TOTP_DIGITS,
	TOTP_PERIOD_SECONDS,
	UNENROLLED_SECRET,
} from "./second-factor";
import { cookieValue, MerchantError, normalizeEmail } from "./security";
import type { MerchantStore } from "./store";

export const SIGNUP_COOKIE = "__Host-quotum_signup";
const GOOGLE_ISSUER = "https://accounts.google.com";
/**
 * Issuers bound to merchant sessions and external identities. Better Auth 1.7.3 identifies
 * accounts by provider and account id again and no longer stores an issuer, so it is derived
 * from the provider here; the values match what Better Auth 1.7.0-1.7.2 wrote for existing rows.
 */
export const ACCOUNT_ISSUERS = { credential: "local:credential", google: GOOGLE_ISSUER } as const;
export function createMerchantAuth(
	store: MerchantStore,
	mailer: MerchantMailer,
	database: BetterAuthOptions["database"],
	testOptions: { googleAuthorizationEndpoint?: string } = {},
) {
	const { config } = store;
	const mcpAuth = createMcpAuthProvider(store);
	const failures = new AsyncLocalStorage<MerchantError[]>();
	// Authenticator secrets and recovery codes are sealed with the library's own key, so they
	// carry its versioned envelope and a later key rotation does not orphan them.
	const sealingKey = async () => (await auth.$context).secretConfig;
	const sealer: SecretSealer = {
		seal: async (plain) => symmetricEncrypt({ key: await sealingKey(), data: plain }),
		open: async (sealed) => symmetricDecrypt({ key: await sealingKey(), data: sealed }),
	};
	const secondFactor = new MerchantSecondFactor(store, sealer);
	const send = async (message: MerchantEmail) => {
		try {
			await mailer.send(message);
		} catch {
			const failure = new MerchantError(
				"EMAIL_DELIVERY_FAILED",
				"We could not send the email. Please try again.",
				503,
			);
			failures.getStore()?.push(failure);
			throw failure;
		}
	};
	if (
		testOptions.googleAuthorizationEndpoint &&
		(!config.testMode ||
			!["127.0.0.1", "localhost", "[::1]"].includes(
				new URL(testOptions.googleAuthorizationEndpoint).hostname,
			))
	)
		throw new Error("Fake Google authorization is restricted to loopback test mode");
	const verifiedGoogle: BetterAuthPlugin = {
		id: "quotum-google-proof",
		init(context) {
			return {
				context: {
					socialProviders: context.socialProviders.map((provider) => {
						if (provider.id !== "google" || !config.google) return provider;
						const clientId = config.google.clientId;
						return {
							...provider,
							requiresIdTokenNonce: true,
							async createAuthorizationURL(input) {
								const url = await provider.createAuthorizationURL(input);
								if (!input.idTokenNonce) throw new Error("Google nonce is required");
								url.searchParams.set("nonce", input.idTokenNonce);
								return url;
							},
							async getUserInfo(tokens) {
								if (!tokens.idToken || !tokens.expectedIdTokenNonce) return null;
								const claims = await verifyGoogleIdToken({
									token: tokens.idToken,
									audience: clientId,
									nonce: tokens.expectedIdTokenNonce,
								});
								if (
									claims?.email_verified !== true ||
									claims.iss !== GOOGLE_ISSUER ||
									typeof claims.sub !== "string"
								)
									return null;
								return provider.getUserInfo(tokens);
							},
						};
					}),
				},
			};
		},
	};
	const auth = betterAuth({
		appName: "Quotum",
		baseURL: config.origin,
		basePath: "/api/auth",
		secret: config.secret,
		// Version 1 is the configured secret, so cookie signing is unchanged and values written
		// before versioned envelopes existed stay readable through `secret` above.
		secrets: [{ version: 1, value: config.secret }],
		database,
		trustedOrigins: [config.origin],
		logger: { disabled: true },
		advanced: {
			useSecureCookies: true,
			cookiePrefix: "quotum-auth",
			database: { generateId: "uuid" },
			ipAddress: { ipAddressHeaders: ["x-quotum-client-ip"] },
		},
		session: { expiresIn: 300, updateAge: 300, cookieCache: { enabled: false } },
		verification: { storeIdentifier: "hashed" },
		account: {
			accountLinking: { enabled: false, disableImplicitLinking: true },
			encryptOAuthTokens: true,
		},
		user: {
			additionalFields: {
				termsVersion: { type: "string", required: false, input: false, returned: false },
				privacyVersion: { type: "string", required: false, input: false, returned: false },
			},
		},
		emailAndPassword: {
			enabled: true,
			minPasswordLength: 12,
			maxPasswordLength: 128,
			requireEmailVerification: true,
			autoSignIn: false,
			revokeSessionsOnPasswordReset: true,
			async sendResetPassword({ user, token }) {
				// A recovery request must not implicitly attach password login to a Google identity.
				const credentials =
					await store.sql`SELECT id FROM platform_auth_accounts WHERE user_id=${user.id} AND provider_id='credential'`;
				if (!credentials.length) return;
				await store.registerLink(token, "reset", 60 * 60_000);
				await send(
					linkMessage(
						user.email,
						"reset",
						"Reset your Quotum password",
						`${config.origin}/reset-password#token=${encodeURIComponent(token)}`,
					),
				);
			},
			async onPasswordReset({ user }) {
				await store.sql.begin(async (tx) => {
					const revoked =
						await tx`UPDATE platform_merchant_sessions SET revoked_at=${store.now()} WHERE principal_id IN (SELECT id FROM platform_principals WHERE auth_user_id=${user.id}) AND revoked_at IS NULL RETURNING id`;
					// A person who never finished signing in has no principal yet; the target names them.
					const [principal] = await tx<
						{ id: string }[]
					>`SELECT id FROM platform_principals WHERE auth_user_id=${user.id}`;
					await store.audit(tx, principal?.id ?? null, null, "password.reset", user.id, {
						sessionsRevoked: revoked.length,
					});
				});
				await new McpAuthorizations(store).revokeUser(user.id);
			},
		},
		emailVerification: {
			sendOnSignUp: true,
			sendOnSignIn: true,
			autoSignInAfterVerification: false,
			expiresIn: 3600,
			async sendVerificationEmail({ user, token }) {
				await store.registerLink(token, "verification", 60 * 60_000);
				await send(
					linkMessage(
						user.email,
						"verification",
						"Verify your Quotum email",
						`${config.origin}/verify-email#token=${encodeURIComponent(token)}`,
					),
				);
			},
		},
		socialProviders: config.google
			? {
					google: {
						...config.google,
						disableImplicitSignUp: true,
						disableIdTokenSignIn: true,
						requireEmailVerification: true,
						scope: ["openid", "email", "profile"],
						accessType: "online",
						includeGrantedScopes: false,
						prompt: "select_account consent",
						authorizationEndpoint: testOptions.googleAuthorizationEndpoint,
					},
				}
			: {},
		rateLimit: {
			enabled: true,
			storage: "database",
			window: 60,
			max: 100,
			customRules: {
				"/two-factor/*": { window: 60, max: 30 },
				"/sign-in/*": { window: 60, max: 100 },
			},
		},
		plugins: [
			verifiedGoogle,
			...mcpAuth.plugins,
			twoFactor({
				totpOptions: { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS },
				backupCodeOptions: {
					amount: RECOVERY_CODE_COUNT,
					length: 10,
					storeBackupCodes: "encrypted",
				},
				twoFactorCookieMaxAge: 600,
				trustDeviceMaxAge: 0,
				accountLockout: {
					enabled: true,
					maxFailedAttempts: SECOND_FACTOR_MAX_FAILURES,
					durationSeconds: SECOND_FACTOR_LOCK_SECONDS,
				},
				otpOptions: {
					digits: 6,
					period: 10,
					allowedAttempts: 5,
					storeOTP: "hashed",
					async sendOTP({ user, otp }) {
						await send({
							to: user.email,
							kind: "otp",
							subject: "Your Quotum authenticator setup code",
							text: `Your code to set up an authenticator app is ${otp}. It expires in 10 minutes.`,
							html: `<p>Your code to set up an authenticator app is <strong>${otp}</strong>.</p><p>It expires in 10 minutes.</p>`,
						});
					},
				},
			}),
		],
		databaseHooks: {
			user: {
				create: {
					before: async (user, ctx) => {
						if (!config.signupEnabled)
							throw new APIError("FORBIDDEN", {
								code: "SIGNUP_DISABLED",
								message: "Registration is not available yet.",
							});
						const headers = ctx?.headers ?? ctx?.request?.headers;
						const intent = headers ? cookieValue(headers, SIGNUP_COOKIE) : null;
						const policy = intent ? await store.readLink(intent, "signup") : null;
						if (
							!policy ||
							policy.termsVersion !== config.termsVersion ||
							policy.privacyVersion !== config.privacyVersion
						)
							throw new APIError("BAD_REQUEST", {
								code: "POLICY_ACCEPTANCE_REQUIRED",
								message: "Accept the current terms and privacy policy to continue.",
							});
						if (ctx?.path?.startsWith("/callback/") && !user.emailVerified)
							throw new APIError("FORBIDDEN", {
								code: "EMAIL_NOT_VERIFIED",
								message: "A verified Google email is required.",
							});
						// OAuth learns the verified email only on callback. Apply the same
						// daily email bucket used by password registration before inserting it.
						if (ctx?.path?.startsWith("/callback/"))
							await store.rateLimit(
								`signup:email:${normalizeEmail(user.email)}`,
								3,
								24 * 60 * 60_000,
							);
						return {
							data: {
								...user,
								// Password sign-up validates the name; a Google profile name is only cleaned.
								name: toDisplayName(user.name ?? "", 100),
								email: normalizeEmail(user.email),
								twoFactorEnabled: true,
								termsVersion: config.termsVersion,
								privacyVersion: config.privacyVersion,
							},
						};
					},
					after: async (user) => {
						// Every account owns one factor row from the start, and the plugin's account lockout counts
						// on it. Until an authenticator is confirmed the row is an unusable placeholder.
						await store.sql`INSERT INTO platform_auth_two_factors(user_id,secret,backup_codes,verified) VALUES(${user.id},${UNENROLLED_SECRET},'[]',false) ON CONFLICT(user_id) DO NOTHING`;
					},
				},
			},
		},
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				await mcpAuth.before(ctx);
				// The signed challenge cookie names who is signing in; without one the plugin answers.
				const secondStep = [
					"/two-factor/send-otp",
					"/two-factor/verify-otp",
					"/two-factor/verify-totp",
				].includes(ctx.path ?? "");
				const challengeCookie = ctx.context.createAuthCookie("two_factor");
				const challenge = secondStep
					? await ctx.getSignedCookie(challengeCookie.name, ctx.context.secret)
					: null;
				const proof = challenge
					? await ctx.context.internalAdapter.findVerificationValue(challenge)
					: null;
				const challenged = proof && proof.expiresAt > new Date() ? proof.value : null;
				if (challenged && ctx.path !== "/two-factor/verify-totp") {
					// An emailed code only proves the mailbox, for an account that has no authenticator yet.
					// Once one is confirmed it is the only way in, besides a recovery code.
					if (await secondFactor.isEnrolled(challenged))
						throw new APIError("FORBIDDEN", {
							code: "OTP_NOT_ALLOWED",
							message: "Use the code shown in your authenticator app, or a recovery code.",
						});
				}
				if (
					challenged &&
					ctx.path === "/two-factor/verify-totp" &&
					typeof ctx.body?.code === "string"
				) {
					// The plugin accepts a code again anywhere inside its window. Claim the step first so a
					// code signs in once. A wrong code falls through, so the plugin counts it as before.
					const claim = await secondFactor.claimTotp(challenged, ctx.body.code);
					if (claim.status === "locked" || claim.status === "replayed") {
						if (claim.status === "replayed") await secondFactor.recordFailure(challenged);
						const error = claim.status === "locked" ? lockedError(claim.until) : replayedCode();
						failures.getStore()?.push(error);
						throw new APIError(claim.status === "locked" ? "TOO_MANY_REQUESTS" : "UNAUTHORIZED", {
							code: error.code,
							message: error.message,
						});
					}
				}
				if (ctx.path === "/two-factor/send-otp") {
					// Check before the plugin replaces an existing code. Better Auth 1.7.2
					// deliberately swallows sendOTP callback errors, so it cannot own throttling.
					if (!proof || proof.expiresAt <= new Date())
						throw new APIError("UNAUTHORIZED", {
							code: "INVALID_TWO_FACTOR_COOKIE",
							message: "Enter your password again to request a code.",
						});
					// Verification would refuse any code until the lockout ends, so send none. The
					// application clock matches the plugin's own lockout check.
					const [locked] =
						await store.sql`SELECT 1 FROM platform_auth_two_factors WHERE user_id=${proof.value} AND locked_until>${new Date()}`;
					if (locked)
						throw new APIError("TOO_MANY_REQUESTS", {
							code: "ACCOUNT_TEMPORARILY_LOCKED",
							message:
								"Too many failed verification attempts. Your account is temporarily locked. Please try again later.",
						});
					try {
						await store.rateLimit(`otp:cooldown:${proof.value}`, 1, 30_000);
						await store.rateLimit(`otp:quarter:${proof.value}`, 3, 15 * 60_000);
						await store.rateLimit(`otp:day:${proof.value}`, 10, 24 * 60 * 60_000);
					} catch (error) {
						if (!(error instanceof MerchantError)) throw error;
						failures.getStore()?.push(error);
						throw new APIError("TOO_MANY_REQUESTS", { code: error.code, message: error.message });
					}
				}
				if (ctx.body?.trustDevice === true)
					throw new APIError("BAD_REQUEST", {
						code: "TRUST_DEVICE_DISABLED",
						message: "A verification code is required for every password sign-in.",
					});
				if (ctx.path === "/sign-in/social") {
					if (ctx.body?.provider !== "google" || ctx.body?.idToken)
						throw new APIError("BAD_REQUEST", {
							code: "PROVIDER_REJECTED",
							message: "Use the Google redirect to sign in.",
						});
				}
			}),
			after: createAuthMiddleware(async (ctx) => {
				await mcpAuth.after(ctx);
				const data = ctx.context.newSession;
				if (!data) return;
				const method =
					ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code"
						? "password"
						: ctx.path === "/callback/google" ||
								(ctx.path === "/callback/:id" && ctx.params?.id === "google")
							? "google"
							: null;
				if (!method && ctx.path !== "/two-factor/verify-otp") return;
				if (!data.user.emailVerified) {
					await store.sql`DELETE FROM platform_auth_sessions WHERE id=${data.session.id}`;
					throw new APIError("FORBIDDEN", {
						code: "EMAIL_NOT_VERIFIED",
						message: "Verify your email before continuing.",
					});
				}
				if (!method) {
					// An emailed code proves the mailbox of an account with no authenticator yet. It is a
					// stage towards enrolling one, never a sign-in: it carries no method or proof time, so
					// the session exchange, step-up and MCP authorization all refuse it.
					await store.sql`UPDATE platform_auth_sessions SET bootstrap_at=${store.now()} WHERE id=${data.session.id}`;
					return;
				}
				if (ctx.path === "/two-factor/verify-backup-code") {
					await secondFactor.syncRecoveryCount(data.user.id);
					// A recovery code is what someone without the authenticator uses, so the person is told.
					// The notice reports the sign-in; a delivery failure must not undo it.
					await mailer
						.send(
							securityNotice(
								data.user.email,
								"a recovery code was used to sign in to your account",
							),
						)
						.catch(() => {});
				}
				const provider = method === "password" ? "credential" : "google";
				const [account] = await store.sql<
					{ account_id: string }[]
				>`SELECT account_id FROM platform_auth_accounts WHERE user_id=${data.user.id} AND provider_id=${provider}`;
				if (!account)
					throw new APIError("UNAUTHORIZED", {
						code: "IDENTITY_MISSING",
						message: "Sign in again to continue.",
					});
				await store.sql`UPDATE platform_auth_sessions SET auth_method=${method},auth_issuer=${ACCOUNT_ISSUERS[provider]},auth_subject=${account.account_id},proof_at=${store.now()} WHERE id=${data.session.id}`;
			}),
		},
	});
	const handler = auth.handler;
	return {
		...auth,
		secondFactor,
		handler: (request: Request) =>
			failures.run([], async () => {
				const response = await handler(request);
				const failure = failures.getStore()?.[0];
				if (failure) {
					// Recovery requests remain non-enumerating even during a delivery outage.
					if (new URL(request.url).pathname === "/api/auth/request-password-reset")
						return Response.json({ status: true });
					throw failure;
				}
				return response;
			}),
	};
}
export type MerchantAuth = ReturnType<typeof createMerchantAuth>;
