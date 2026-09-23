import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

const dates = () => ({
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const user = pgTable("platform_auth_users", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").notNull().default(false),
	image: text("image"),
	twoFactorEnabled: boolean("two_factor_enabled").notNull().default(true),
	termsVersion: text("terms_version"),
	privacyVersion: text("privacy_version"),
	...dates(),
});
export const account = pgTable(
	"platform_auth_accounts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
		scope: text("scope"),
		password: text("password"),
		...dates(),
	},
	(table) => [
		uniqueIndex("auth_accounts_provider_account_id_key").on(table.providerId, table.accountId),
		index("auth_accounts_user_idx").on(table.userId),
	],
);
export const session = pgTable(
	"platform_auth_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		token: text("token").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		authMethod: text("auth_method"),
		authIssuer: text("auth_issuer"),
		authSubject: text("auth_subject"),
		proofAt: timestamp("proof_at", { withTimezone: true }),
		mcpRequestHash: text("mcp_request_hash"),
		...dates(),
	},
	(table) => [
		index("auth_sessions_user_idx").on(table.userId),
		index("auth_sessions_expiry_idx").on(table.expiresAt),
	],
);
export const verification = pgTable(
	"platform_auth_verifications",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		...dates(),
	},
	(table) => [
		index("auth_verifications_identifier_idx").on(table.identifier),
		index("auth_verifications_expiry_idx").on(table.expiresAt),
	],
);
export const twoFactor = pgTable(
	"platform_auth_two_factors",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		secret: text("secret").notNull(),
		backupCodes: text("backup_codes").notNull(),
		verified: boolean("verified").default(true),
		failedVerificationCount: integer("failed_verification_count").notNull().default(0),
		lockedUntil: timestamp("locked_until", { withTimezone: true }),
	},
	(table) => [
		index("auth_two_factors_user_idx").on(table.userId),
		uniqueIndex("auth_two_factors_user_unique").on(table.userId),
		index("auth_two_factors_secret_idx").on(table.secret),
	],
);
export const rateLimit = pgTable("platform_auth_rate_limits", {
	id: uuid("id").primaryKey().defaultRandom(),
	key: text("key").notNull().unique(),
	count: integer("count").notNull(),
	lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const jwks = pgTable("platform_auth_jwks", {
	id: uuid("id").primaryKey().defaultRandom(),
	publicKey: text("public_key").notNull(),
	privateKey: text("private_key").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true }),
	alg: text("alg"),
	crv: text("crv"),
});
export const oauthClient = pgTable("platform_auth_oauth_clients", {
	id: uuid("id").primaryKey().defaultRandom(),
	clientId: text("client_id").notNull().unique(),
	clientSecret: text("client_secret"),
	clientDiscoveryId: text("client_discovery_id"),
	disabled: boolean("disabled").default(false),
	skipConsent: boolean("skip_consent"),
	enableEndSession: boolean("enable_end_session"),
	subjectType: text("subject_type"),
	scopes: text("scopes").array(),
	clientCredentialsScopes: text("client_credentials_scopes").array(),
	userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
	createdAt: timestamp("created_at", { withTimezone: true }),
	updatedAt: timestamp("updated_at", { withTimezone: true }),
	name: text("name"),
	uri: text("uri"),
	icon: text("icon"),
	contacts: text("contacts").array(),
	tos: text("tos"),
	policy: text("policy"),
	softwareId: text("software_id"),
	softwareVersion: text("software_version"),
	softwareStatement: text("software_statement"),
	redirectUris: text("redirect_uris").array().notNull(),
	postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
	backchannelLogoutUri: text("backchannel_logout_uri"),
	backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
	tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
	applicationType: text("application_type"),
	jwks: text("jwks"),
	jwksUri: text("jwks_uri"),
	grantTypes: text("grant_types").array(),
	responseTypes: text("response_types").array(),
	requirePKCE: boolean("require_p_k_c_e"),
	dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
	referenceId: text("reference_id"),
	metadata: jsonb("metadata"),
});
export const oauthResource = pgTable("platform_auth_oauth_resources", {
	id: uuid("id").primaryKey().defaultRandom(),
	identifier: text("identifier").notNull().unique(),
	name: text("name").notNull(),
	accessTokenTtl: integer("access_token_ttl"),
	refreshTokenTtl: integer("refresh_token_ttl"),
	signingAlgorithm: text("signing_algorithm"),
	signingKeyId: text("signing_key_id"),
	allowedScopes: text("allowed_scopes").array(),
	customClaims: jsonb("custom_claims"),
	dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
	disabled: boolean("disabled").default(false),
	createdAt: timestamp("created_at", { withTimezone: true }),
	updatedAt: timestamp("updated_at", { withTimezone: true }),
	policyVersion: integer("policy_version").default(1),
	metadata: jsonb("metadata"),
});
export const oauthClientResource = pgTable("platform_auth_oauth_client_resources", {
	id: uuid("id").primaryKey().defaultRandom(),
	clientId: text("client_id")
		.notNull()
		.references(() => oauthClient.clientId, { onDelete: "cascade" }),
	resourceId: text("resource_id")
		.notNull()
		.references(() => oauthResource.identifier, { onDelete: "cascade" }),
	metadata: jsonb("metadata"),
	createdAt: timestamp("created_at", { withTimezone: true }),
});
export const oauthRefreshToken = pgTable("platform_auth_oauth_refresh_tokens", {
	id: uuid("id").primaryKey().defaultRandom(),
	token: text("token").notNull().unique(),
	clientId: text("client_id")
		.notNull()
		.references(() => oauthClient.clientId, { onDelete: "cascade" }),
	sessionId: uuid("session_id").references(() => session.id, { onDelete: "set null" }),
	userId: uuid("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	referenceId: text("reference_id"),
	authorizationCodeId: text("authorization_code_id"),
	resources: text("resources").array(),
	requestedUserInfoClaims: text("requested_user_info_claims").array(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	revoked: timestamp("revoked", { withTimezone: true }),
	rotatedAt: timestamp("rotated_at", { withTimezone: true }),
	rotationReplayResponse: text("rotation_replay_response"),
	rotationReplayExpiresAt: timestamp("rotation_replay_expires_at", { withTimezone: true }),
	authTime: timestamp("auth_time", { withTimezone: true }),
	confirmation: jsonb("confirmation"),
	scopes: text("scopes").array().notNull(),
});
export const oauthAccessToken = pgTable("platform_auth_oauth_access_tokens", {
	id: uuid("id").primaryKey().defaultRandom(),
	token: text("token").notNull().unique(),
	clientId: text("client_id")
		.notNull()
		.references(() => oauthClient.clientId, { onDelete: "cascade" }),
	sessionId: uuid("session_id").references(() => session.id, { onDelete: "set null" }),
	userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
	referenceId: text("reference_id"),
	authorizationCodeId: text("authorization_code_id"),
	resources: text("resources").array(),
	requestedUserInfoClaims: text("requested_user_info_claims").array(),
	refreshId: uuid("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	revoked: timestamp("revoked", { withTimezone: true }),
	confirmation: jsonb("confirmation"),
	scopes: text("scopes").array().notNull(),
});
export const oauthConsent = pgTable("platform_auth_oauth_consents", {
	id: uuid("id").primaryKey().defaultRandom(),
	clientId: text("client_id")
		.notNull()
		.references(() => oauthClient.clientId, { onDelete: "cascade" }),
	userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
	referenceId: text("reference_id"),
	resources: text("resources").array(),
	requestedUserInfoClaims: text("requested_user_info_claims").array(),
	scopes: text("scopes").array().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
export const oauthClientAssertion = pgTable("platform_auth_oauth_client_assertions", {
	id: uuid("id").primaryKey().defaultRandom(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
