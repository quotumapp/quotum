import { sql as drizzleSql } from "drizzle-orm";
import { databaseDecimal, decimalToUnits, unitsToDecimal } from "../../billing/decimal";
import {
	combineMeterLimits,
	type MeterLimitRow,
	queryMeterLimitRows,
	unlimitedLiftsCap,
} from "./meter-limit-sources";
import { executeRows } from "./query";
import type { QueryExecutor, TransactionalQueryExecutor } from "./types";

/**
 * A read-only report of how the declared meter-limit scope (PC-04) will apply to this database:
 * which plan versions cap each feature with which scope, which accounts hold usage that the
 * declared scope will sum, and which configurations the scope release will refuse. It writes
 * nothing and takes no locks beyond plain reads, inside one read-only snapshot.
 */

export type DeclaredScope = "account" | "entity" | "license_pool";

export interface UsageScopesReportOptions {
	/** Report one project instance only; every project otherwise. */
	projectKey?: string | null;
	/** How many account groups to list per project. */
	accountLimit: number;
}

export interface ScopeVersionLimit {
	plan: string;
	version: number;
	planKind: "base" | "addon";
	/** The plan's current version, offered to new purchases. */
	published: boolean;
	scope: DeclaredScope;
	overagePolicy: "blocked" | "allowed";
	quantity: string;
	reset: { interval: string; intervalCount: number } | null;
	/** Live subscriptions pinned to the version. */
	subscriptions: number;
	/** Active trial and default-plan grants on the version. */
	planGrants: number;
}

export interface FeatureScopes {
	featureKey: string;
	limits: ScopeVersionLimit[];
}

export type ScopeVersionRef = Pick<
	ScopeVersionLimit,
	"plan" | "version" | "planKind" | "scope" | "published" | "subscriptions" | "planGrants"
>;

export interface MixedScopeConfiguration {
	featureKey: string;
	first: ScopeVersionRef;
	second: ScopeVersionRef;
}

export interface MixedScopeAccount {
	billingAccountId: string;
	featureKey: string;
	sources: Array<{ plan: string; version: number; scope: DeclaredScope }>;
}

export interface PostpaidEntityFanOut {
	featureKey: string;
	limit: ScopeVersionRef;
}

export interface AccountScopeGroup {
	billingAccountId: string;
	featureKey: string;
	windowStartAt: string;
	windowEndAt: string;
	/** The scope the declared rule enforces for this group; `unresolved` when nothing caps it now. */
	scope: DeclaredScope | "unresolved";
	/** The entity of an entity-scoped group, or null for the account and the no-entity bucket. */
	entity: string | null;
	/** Today's per-entity, per-filter windows that the declared rule sums into this group. */
	windows: number;
	entities: number;
	filters: number;
	usage: string;
	held: string;
	limit: string | null;
	overagePolicy: "blocked" | "allowed" | null;
	/** A hard cap that usage plus active holds already exceeds. */
	overCap: boolean;
}

export interface ProjectScopesReport {
	project: { key: string; environment: string };
	features: FeatureScopes[];
	/** Items that must be resolved before the scope transition. */
	blocking: {
		mixedScopeAccounts: MixedScopeAccount[];
		postpaidEntityFanOut: PostpaidEntityFanOut[];
		unresolvedWindows: AccountScopeGroup[];
	};
	/** Items the scope release refuses at the next publication, which no account depends on yet. */
	warnings: {
		mixedScopeConfigurations: MixedScopeConfiguration[];
		postpaidEntityFanOut: PostpaidEntityFanOut[];
	};
	accounts: {
		openWindows: number;
		groups: number;
		/** Groups whose enforcement changes: several of today's windows are summed into one. */
		affectedGroups: number;
		overCapGroups: number;
		listed: AccountScopeGroup[];
		truncated: boolean;
	};
}

export interface UsageScopesReport {
	generatedAt: string;
	projects: ProjectScopesReport[];
	blockingItems: number;
	warningItems: number;
}

/** Reads the report inside one read-only, repeatable-read transaction. */
export async function readUsageScopesReportSnapshot(
	database: TransactionalQueryExecutor,
	options: UsageScopesReportOptions,
): Promise<UsageScopesReport> {
	return await database.transaction(async (tx) => {
		await executeRows(tx, drizzleSql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
		return await readUsageScopesReport(tx, options);
	});
}

export async function readUsageScopesReport(
	executor: QueryExecutor,
	options: UsageScopesReportOptions,
): Promise<UsageScopesReport> {
	const [clock] = await executeRows<{ now: Date | string }>(
		executor,
		drizzleSql`SELECT now() AS now`,
	);
	const projects = await executeRows<{ id: string; key: string; environment: string }>(
		executor,
		drizzleSql`
			SELECT id::text, key, environment
			FROM projects
			WHERE (${options.projectKey ?? null}::text IS NULL OR key = ${options.projectKey ?? null}::text)
			ORDER BY key
		`,
	);
	if (options.projectKey && projects.length === 0) {
		throw new UsageScopesReportError(`No project instance ${JSON.stringify(options.projectKey)}.`);
	}
	const reports: ProjectScopesReport[] = [];
	for (const project of projects) {
		reports.push(await readProjectReport(executor, project, options.accountLimit));
	}
	const count = (part: Record<string, unknown[]>) =>
		Object.values(part).reduce((sum, items) => sum + items.length, 0);
	return {
		generatedAt: new Date(clock?.now ?? Date.now()).toISOString(),
		projects: reports,
		blockingItems: reports.reduce((sum, report) => sum + count(report.blocking), 0),
		warningItems: reports.reduce((sum, report) => sum + count(report.warnings), 0),
	};
}

/** A project instance named on the command line that the database does not hold. */
export class UsageScopesReportError extends Error {}

export interface MeterLimitItemRow {
	item_id: string;
	version_id: string;
	feature_id: string;
	feature_key: string;
	credit_scale: number;
	plan_key: string;
	version: number;
	plan_kind: "base" | "addon";
	published: boolean;
	scope: DeclaredScope;
	overage_policy: "blocked" | "allowed";
	quantity: string;
	reset_interval: string | null;
	reset_interval_count: number;
	subscriptions: number | string;
	plan_grants: number | string;
}

export interface WindowRow {
	customer_id: string;
	billing_account_id: string;
	feature_id: string;
	feature_key: string;
	credit_scale: number;
	entity_id: string | null;
	entity_external_id: string | null;
	filter_key: string | null;
	window_start_at: Date | string;
	window_end_at: Date | string;
	usage: string;
	held: string;
}

async function readProjectReport(
	executor: QueryExecutor,
	project: { id: string; key: string; environment: string },
	accountLimit: number,
): Promise<ProjectScopesReport> {
	const items = await executeRows<MeterLimitItemRow>(
		executor,
		drizzleSql`
			SELECT
				item.id::text AS item_id,
				version.id::text AS version_id,
				feature.id::text AS feature_id,
				feature.key AS feature_key,
				feature.credit_scale,
				plan.key AS plan_key,
				version.version,
				version.plan_kind,
				(plan.active AND plan.active_version_id = version.id) AS published,
				item.allocation_scope AS scope,
				item.overage_policy,
				item.quantity::text AS quantity,
				item.reset_interval,
				item.reset_interval_count,
				(
					SELECT count(*)
					FROM subscriptions subscription
					WHERE subscription.project_id = version.project_id
						AND subscription.plan_version_id = version.id
						AND subscription.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
						AND (subscription.expires_at IS NULL OR subscription.expires_at > now())
				) AS subscriptions,
				(
					SELECT count(*)
					FROM plan_grants grant_row
					WHERE grant_row.project_id = version.project_id
						AND grant_row.plan_version_id = version.id
						AND grant_row.status = 'active'
						AND (grant_row.ends_at IS NULL OR grant_row.ends_at > now())
				) AS plan_grants
			FROM plan_items item
			JOIN plan_versions version
				ON version.project_id = item.project_id AND version.id = item.plan_version_id
			JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
			JOIN features feature ON feature.project_id = item.project_id AND feature.id = item.feature_id
			WHERE item.project_id = ${project.id}::uuid
				AND item.item_kind = 'meter_limit'
			ORDER BY feature.key, plan.key, version.version
		`,
	);
	const limits = items
		.map((row) => ({ row, limit: versionLimit(row) }))
		.filter(({ limit }) => limit.published || limit.subscriptions > 0 || limit.planGrants > 0);
	const features = groupFeatures(limits);
	const configurations = mixedScopeConfigurations(features);
	const fanOut = features.flatMap((feature) =>
		feature.limits
			.filter((limit) => limit.scope === "entity" && limit.overagePolicy === "allowed")
			.map((limit) => ({ featureKey: feature.featureKey, limit: versionRef(limit) })),
	);

	const windows = await executeRows<WindowRow>(
		executor,
		drizzleSql`
			SELECT
				window_row.customer_id::text AS customer_id,
				customer.billing_account_id,
				window_row.feature_id::text AS feature_id,
				feature.key AS feature_key,
				feature.credit_scale,
				window_row.entity_id::text AS entity_id,
				entity.external_id AS entity_external_id,
				window_row.filter_key,
				window_row.window_start_at,
				window_row.window_end_at,
				window_row.usage::text AS usage,
				COALESCE(holds.held, 0)::text AS held
			FROM usage_windows window_row
			JOIN customers customer
				ON customer.project_id = window_row.project_id AND customer.id = window_row.customer_id
			JOIN features feature
				ON feature.project_id = window_row.project_id AND feature.id = window_row.feature_id
			LEFT JOIN entities entity
				ON entity.project_id = window_row.project_id AND entity.id = window_row.entity_id
			LEFT JOIN LATERAL (
				SELECT sum(reservation.held_quantity) AS held
				FROM reservations reservation
				WHERE reservation.project_id = window_row.project_id
					AND reservation.usage_window_id = window_row.id
					AND reservation.status = 'active'
					AND reservation.expires_at > now()
			) holds ON true
			WHERE window_row.project_id = ${project.id}::uuid
				AND window_row.window_start_at <= now()
				AND window_row.window_end_at > now()
			ORDER BY customer.billing_account_id, feature.key, window_row.window_start_at, window_row.id
		`,
	);

	const mixedAccounts = await readMixedScopeAccounts(executor, project.id);
	const groups: AccountScopeGroup[] = [];
	const itemsById = new Map(items.map((row) => [row.item_id, row]));
	for (const accountWindows of groupBy(windows, (row) => `${row.customer_id}|${row.feature_id}`)) {
		const first = accountWindows[0] as WindowRow;
		const sources = await queryMeterLimitRows(executor, project.id, first.customer_id, {
			id: first.feature_id,
		});
		const resolved = resolveAccountScope(sources, itemsById, first.credit_scale);
		groups.push(...groupAccountWindows(accountWindows, resolved));
	}
	const unresolved = groups.filter((group) => group.scope === "unresolved");
	const affected = groups.filter((group) => group.scope !== "unresolved" && group.windows > 1);
	const overCap = groups.filter((group) => group.overCap);
	const listed = [...new Set([...overCap, ...affected])].sort(compareAccountGroups);

	return {
		project: { key: project.key, environment: project.environment },
		features,
		blocking: {
			mixedScopeAccounts: mixedAccounts,
			postpaidEntityFanOut: fanOut.filter(
				({ limit }) => limit.subscriptions + limit.planGrants > 0,
			),
			unresolvedWindows: unresolved,
		},
		warnings: {
			mixedScopeConfigurations: configurations,
			postpaidEntityFanOut: fanOut.filter(
				({ limit }) => limit.subscriptions + limit.planGrants === 0,
			),
		},
		accounts: {
			openWindows: windows.length,
			groups: groups.length,
			affectedGroups: affected.length,
			overCapGroups: overCap.length,
			listed: listed.slice(0, accountLimit),
			truncated: listed.length > accountLimit,
		},
	};
}

function versionLimit(row: MeterLimitItemRow): ScopeVersionLimit {
	return {
		plan: row.plan_key,
		version: Number(row.version),
		planKind: row.plan_kind,
		published: row.published === true,
		scope: row.scope,
		overagePolicy: row.overage_policy,
		quantity: unitsToDecimal(
			decimalToUnits(databaseDecimal(row.quantity, "meter limit"), row.credit_scale),
			row.credit_scale,
		),
		reset:
			row.reset_interval === null
				? null
				: { interval: row.reset_interval, intervalCount: Number(row.reset_interval_count) },
		subscriptions: Number(row.subscriptions),
		planGrants: Number(row.plan_grants),
	};
}

function versionRef(limit: ScopeVersionLimit): ScopeVersionRef {
	const { plan, version, planKind, scope, published, subscriptions, planGrants } = limit;
	return { plan, version, planKind, scope, published, subscriptions, planGrants };
}

function groupFeatures(
	limits: ReadonlyArray<{ row: MeterLimitItemRow; limit: ScopeVersionLimit }>,
): FeatureScopes[] {
	const features = new Map<string, FeatureScopes>();
	for (const { row, limit } of limits) {
		const feature = features.get(row.feature_key) ?? { featureKey: row.feature_key, limits: [] };
		feature.limits.push(limit);
		features.set(row.feature_key, feature);
	}
	return [...features.values()];
}

/**
 * Pairs of plan versions one account could hold together that cap a feature with different scopes:
 * a base version with an add-on version, or two add-ons of different plans. Base plans are mutually
 * exclusive, so two base versions never pair.
 */
export function mixedScopeConfigurations(
	features: readonly FeatureScopes[],
): MixedScopeConfiguration[] {
	const pairs: MixedScopeConfiguration[] = [];
	for (const feature of features) {
		const limits = feature.limits;
		for (let left = 0; left < limits.length; left += 1) {
			for (let right = left + 1; right < limits.length; right += 1) {
				const first = limits[left] as ScopeVersionLimit;
				const second = limits[right] as ScopeVersionLimit;
				if (first.scope === second.scope) continue;
				if (first.planKind === "base" && second.planKind === "base") continue;
				if (first.plan === second.plan) continue;
				pairs.push({
					featureKey: feature.featureKey,
					first: versionRef(first),
					second: versionRef(second),
				});
			}
		}
	}
	return pairs;
}

export interface ResolvedAccountScope {
	scope: DeclaredScope | "unresolved";
	limit: string | null;
	overagePolicy: "blocked" | "allowed" | null;
}

/**
 * The scope and cap the account's current meter-limit sources give the feature: the anchor's
 * declared scope, and the summed quantity meter-limit resolution already computes. An active
 * unlimited usage source lifts the cap, so the account reports no limit.
 */
export function resolveAccountScope(
	sources: readonly MeterLimitRow[],
	itemsById: ReadonlyMap<string, Pick<MeterLimitItemRow, "scope">>,
	scale: number,
): ResolvedAccountScope {
	const combined = combineMeterLimits(sources, scale);
	if (combined === null) return { scope: "unresolved", limit: null, overagePolicy: null };
	return {
		scope: itemsById.get(String(combined.anchor.plan_item_id))?.scope ?? "account",
		limit: unlimitedLiftsCap(sources, combined.anchor) ? null : combined.quantity,
		overagePolicy: combined.anchor.overage_policy,
	};
}

/**
 * Accounts whose live subscriptions cap one feature with different declared scopes, whether or not
 * they have used it yet. The declared-scope release refuses these, so they block its upgrade.
 */
export async function readMixedScopeAccounts(
	executor: QueryExecutor,
	projectId: string,
): Promise<MixedScopeAccount[]> {
	const rows = await executeRows<{
		billing_account_id: string;
		feature_key: string;
		sources: Array<{ plan: string; version: number; scope: DeclaredScope }>;
	}>(
		executor,
		drizzleSql`
			SELECT
				customer.billing_account_id,
				feature.key AS feature_key,
				jsonb_agg(
					jsonb_build_object('plan', plan.key, 'version', version.version, 'scope', item.allocation_scope)
					ORDER BY plan.key, version.version
				) AS sources
			FROM subscriptions subscription
			JOIN customers customer
				ON customer.project_id = subscription.project_id AND customer.id = subscription.customer_id
			JOIN plan_versions version
				ON version.project_id = subscription.project_id
				AND version.id = subscription.plan_version_id
			JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
			JOIN plan_items item
				ON item.project_id = version.project_id
				AND item.plan_version_id = version.id
				AND item.item_kind = 'meter_limit'
			JOIN features feature ON feature.project_id = item.project_id AND feature.id = item.feature_id
			WHERE subscription.project_id = ${projectId}::uuid
				AND subscription.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
				AND (subscription.expires_at IS NULL OR subscription.expires_at > now())
			GROUP BY customer.billing_account_id, feature.key
			HAVING count(DISTINCT item.allocation_scope) > 1
			ORDER BY customer.billing_account_id, feature.key
		`,
	);
	return rows.map((row) => ({
		billingAccountId: row.billing_account_id,
		featureKey: row.feature_key,
		sources: row.sources.map((source) => ({ ...source, version: Number(source.version) })),
	}));
}

/**
 * Sums one account's open windows of a feature the way the declared scope will: an account scope
 * sums every entity and filter in a window; an entity scope sums per entity (the no-entity usage
 * in its own bucket), across filters.
 */
export function groupAccountWindows(
	rows: readonly WindowRow[],
	resolved: Pick<ResolvedAccountScope, "scope" | "limit" | "overagePolicy">,
): AccountScopeGroup[] {
	const groups: AccountScopeGroup[] = [];
	for (const bounded of groupBy(
		rows,
		(row) => `${iso(row.window_start_at)}|${iso(row.window_end_at)}`,
	)) {
		const parts =
			resolved.scope === "entity" ? groupBy(bounded, (row) => row.entity_id ?? "") : [bounded];
		for (const part of parts) {
			const first = part[0] as WindowRow;
			const units = (field: "usage" | "held") =>
				part.reduce((sum, row) => sum + decimalToUnits(databaseDecimal(row[field], field), 9), 0n);
			const usage = units("usage");
			const held = units("held");
			const limitUnits =
				resolved.limit === null
					? null
					: decimalToUnits(databaseDecimal(resolved.limit, "limit"), 9);
			groups.push({
				billingAccountId: first.billing_account_id,
				featureKey: first.feature_key,
				windowStartAt: iso(first.window_start_at),
				windowEndAt: iso(first.window_end_at),
				scope: resolved.scope,
				entity: resolved.scope === "entity" ? first.entity_external_id : null,
				windows: part.length,
				entities: new Set(part.map((row) => row.entity_id ?? "")).size,
				filters: new Set(part.map((row) => row.filter_key ?? "")).size,
				usage: unitsToDecimal(usage, 9),
				held: unitsToDecimal(held, 9),
				limit: resolved.limit,
				overagePolicy: resolved.overagePolicy,
				overCap:
					resolved.overagePolicy === "blocked" && limitUnits !== null && usage + held > limitUnits,
			});
		}
	}
	return groups;
}

/** Over-cap groups first, then the largest usage plus holds, then by account and feature. */
export function compareAccountGroups(left: AccountScopeGroup, right: AccountScopeGroup): number {
	if (left.overCap !== right.overCap) return left.overCap ? -1 : 1;
	const byUsage =
		decimalToUnits(right.usage, 9) +
		decimalToUnits(right.held, 9) -
		(decimalToUnits(left.usage, 9) + decimalToUnits(left.held, 9));
	if (byUsage !== 0n) return byUsage > 0n ? 1 : -1;
	return `${left.billingAccountId}|${left.featureKey}`.localeCompare(
		`${right.billingAccountId}|${right.featureKey}`,
	);
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): T[][] {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const name = key(row);
		const group = groups.get(name) ?? [];
		group.push(row);
		groups.set(name, group);
	}
	return [...groups.values()];
}

function iso(value: Date | string): string {
	return new Date(value).toISOString();
}
