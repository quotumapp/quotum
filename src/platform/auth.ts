import { AsyncLocalStorage } from "node:async_hooks";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import { verifyGoogleIdToken } from "better-auth/social-providers";
import type { MerchantEmail, MerchantMailer } from "./email";
import { linkMessage } from "./email";
import { cookieValue, MerchantError, normalizeEmail } from "./security";
import type { MerchantStore } from "./store";

export const SIGNUP_COOKIE = "__Host-quotum_signup";
export function createMerchantAuth(
	store: MerchantStore,
	mailer: MerchantMailer,
	database: BetterAuthOptions["database"],
	testOptions: { googleAuthorizationEndpoint?: string } = {},
) {
	const { config } = store;
	const failures = new AsyncLocalStorage<MerchantError[]>();
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
									claims.iss !== "https://accounts.google.com" ||
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
				await store.sql`UPDATE platform_merchant_sessions SET revoked_at=${store.now()} WHERE principal_id IN (SELECT id FROM platform_principals WHERE auth_user_id=${user.id}) AND revoked_at IS NULL`;
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
			twoFactor({
				totpOptions: { disable: true },
				twoFactorCookieMaxAge: 600,
				trustDeviceMaxAge: 0,
				accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
				otpOptions: {
					digits: 6,
					period: 10,
					allowedAttempts: 5,
					storeOTP: "hashed",
					async sendOTP({ user, otp }) {
						await send({
							to: user.email,
							kind: "otp",
							subject: "Your Quotum verification code",
							text: `Your verification code is ${otp}. It expires in 10 minutes.`,
							html: `<p>Your verification code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes.</p>`,
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
								email: normalizeEmail(user.email),
								twoFactorEnabled: true,
								termsVersion: config.termsVersion,
								privacyVersion: config.privacyVersion,
							},
						};
					},
					after: async (user) => {
						// Email-only accounts still need the plugin's persistent account lockout row.
						// TOTP and backup-code endpoints are disabled; these placeholders are not usable factors.
						await store.sql`INSERT INTO platform_auth_two_factors(user_id,secret,backup_codes,verified) VALUES(${user.id},'email-otp-only','[]',false) ON CONFLICT(user_id) DO NOTHING`;
					},
				},
			},
		},
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/two-factor/send-otp") {
					// Check before the plugin replaces an existing code. Better Auth 1.7.2
					// deliberately swallows sendOTP callback errors, so it cannot own throttling.
					const cookie = ctx.context.createAuthCookie("two_factor");
					const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
					const proof = challenge
						? await ctx.context.internalAdapter.findVerificationValue(challenge)
						: null;
					if (!proof || proof.expiresAt <= new Date())
						throw new APIError("UNAUTHORIZED", {
							code: "INVALID_TWO_FACTOR_COOKIE",
							message: "Enter your password again to request a code.",
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
				const data = ctx.context.newSession;
				if (!data) return;
				const method =
					ctx.path === "/two-factor/verify-otp"
						? "password"
						: ctx.path === "/callback/google" ||
								(ctx.path === "/callback/:id" && ctx.params?.id === "google")
							? "google"
							: null;
				if (!method) return;
				if (!data.user.emailVerified) {
					await store.sql`DELETE FROM platform_auth_sessions WHERE id=${data.session.id}`;
					throw new APIError("FORBIDDEN", {
						code: "EMAIL_NOT_VERIFIED",
						message: "Verify your email before continuing.",
					});
				}
				const provider = method === "password" ? "credential" : "google";
				const [account] = await store.sql<
					{ issuer: string; account_id: string }[]
				>`SELECT issuer,account_id FROM platform_auth_accounts WHERE user_id=${data.user.id} AND provider_id=${provider}`;
				if (!account)
					throw new APIError("UNAUTHORIZED", {
						code: "IDENTITY_MISSING",
						message: "Sign in again to continue.",
					});
				await store.sql`UPDATE platform_auth_sessions SET auth_method=${method},auth_issuer=${account.issuer},auth_subject=${account.account_id},proof_at=${store.now()} WHERE id=${data.session.id}`;
			}),
		},
	});
	const handler = auth.handler;
	return {
		...auth,
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
