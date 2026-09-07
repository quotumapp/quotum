import {
	bigint,
	boolean,
	index,
	integer,
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
		issuer: text("issuer").notNull(),
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
		uniqueIndex("auth_accounts_issuer_account_id_key").on(table.issuer, table.accountId),
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
