import { writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { SQL } from "bun";
import { createBillingDatabaseConnection } from "../src/db/client";
import { BillingRepository } from "../src/db/repository";
import { e2eServiceEnv } from "../tests/e2e/helpers/e2e-env";
import {
	type BillingServiceProcess,
	startBillingService,
} from "../tests/e2e/helpers/service-process";
import { resetAndSeedIntegrationData } from "../tests/integration/helpers/catalog-fixtures";
import { publishAiCreditsCatalog } from "../tests/integration/helpers/metering-catalog";
import { integrationProjectContext } from "../tests/integration/helpers/platform-fixture";
import { trapInterrupts } from "./lib/interrupts";
import { driveUserArrivals } from "./lib/load-arrivals";
import { evaluateLoadGates } from "./lib/load-gates";
import {
	applyTestcontainersDefaults,
	createPostgresContainer,
	run,
} from "./lib/postgres-container";
import { createSanitizedProcessEnv } from "./lib/sanitized-env";
import { bootstrapTestPlatform } from "./lib/test-platform-bootstrap";

/**
 * Load lane: boots the real service against a disposable Postgres and measures the metering hot
 * path on Postgres alone. Numbers from a laptop container are shapes, not capacity claims; run
 * with POSTGRES_URI against a sized instance for figures worth quoting.
 */

type ScenarioKind = "hot" | "spread" | "reserve" | "check" | "workers-off" | "users";

interface Options {
	durationMs: number;
	warmupMs: number;
	concurrency: readonly number[];
	accounts: number;
	scenarios: readonly ScenarioKind[];
	out: string | null;
	postgresUri: string | null;
	pgConfig: readonly string[];
	profile: "consume" | "check" | "reserve" | null;
	recreateSchema: boolean;
	minRps: number | null;
	maxP99Ms: number | null;
	users: readonly number[];
	maxInFlight: number;
	requestTimeoutMs: number;
	drainMs: number;
}

interface DbSnapshot {
	xactCommit: number;
	walLsn: string;
	deadTuples: number;
	projectionJobs: number;
	projectionBacklog: number;
	statementCalls: number | null;
	statementExecMs: number | null;
}

interface RunResult {
	scenario: ScenarioKind;
	operation: string;
	concurrency: number;
	durationMs: number;
	requests: number;
	ledgerCalls: number;
	unitsPerCall: number;
	rps: number;
	ledgerCallsPerSecond: number;
	clientMs: { p50: number; p95: number; p99: number; max: number };
	serverMs: { p50: number | null; p99: number | null; count: number };
	statuses: Record<string, number>;
	denied: number;
	db: {
		xactPerSecond: number;
		walMb: number;
		deadTuplesDelta: number;
		lockWaitSamples: { max: number; mean: number };
		projectionJobsCreated: number;
		projectionDelivered: number;
		projectionBacklogAfter: number;
		statementsPerRequest: number | null;
		dbExecMsPerRequest: number | null;
	};
	cpu: { servicePercent: number | null; postgresPercent: number | null };
	arrivals?: {
		users: number;
		windowMs: number;
		scheduled: number;
		sent: number;
		droppedCapacity: number;
		droppedLate: number;
		peakInFlight: number;
		inFlightAtEnd: number;
		accepted: number;
		acceptedDuringWindow: number;
		requestDrainMs: number;
		schedulingLagP99Ms: number;
		scheduledLatencyP99Ms: number;
		projectionBacklogBefore: number;
		projectionBacklogAtEnd: number;
		projectionDrainMs: number;
		accounting: { committed: number; missingAccepted: number; invalidEvents: number };
	};
}

const defaultConcurrency = [1, 8, 32, 64] as const;
const defaultScenarios: readonly ScenarioKind[] = [
	"hot",
	"spread",
	"reserve",
	"check",
	"workers-off",
];
const hotAccount = "load-hot";
const postgresDatabase = "quotum_billing_load";

const interrupts = trapInterrupts();
try {
	await main(parseOptions(process.argv.slice(2)));
} catch (error) {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = interrupts.exitCode() ?? 1;
}

async function main(options: Options): Promise<void> {
	let container: StartedPostgreSqlContainer | undefined;
	let postgresUri = options.postgresUri;
	if (postgresUri === null) {
		applyTestcontainersDefaults(process.env);
		container = await createPostgresContainer({ postgresDatabase })
			.withCommand([
				"postgres",
				"-c",
				"shared_preload_libraries=pg_stat_statements",
				...options.pgConfig.flatMap((setting) => ["-c", setting]),
			])
			.start();
		postgresUri = container.getConnectionUri();
	}
	if (options.recreateSchema) {
		// A reused target keeps its earlier bootstrap, which issues no fresh credential; start over.
		const admin = new SQL(postgresUri, { max: 1 });
		try {
			await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
			await admin.unsafe("CREATE SCHEMA public");
		} finally {
			await admin.close();
		}
	}
	const baseEnv = {
		...createSanitizedProcessEnv(),
		NODE_ENV: "test",
		POSTGRES_URI: postgresUri,
	};
	run("bun", ["run", "migrate"], { env: baseEnv });
	const platform = await bootstrapTestPlatform(postgresUri, ["voysee", "wiseley"]);
	process.env.BILLING_TEST_PROJECT_CONTEXTS_JSON = JSON.stringify(platform.contexts);
	process.env.BILLING_TEST_PROJECT_CREDENTIALS_JSON = JSON.stringify(platform.credentials);
	const apiKey = platform.credentials.voysee;
	if (apiKey === undefined) throw new Error("Load lane did not receive the voysee credential");

	const connection = createBillingDatabaseConnection({ postgresUri });
	const sampler = new SQL(postgresUri, { max: 1 });
	const receiver = createCountingReceiver();
	let service: BillingServiceProcess | null = null;
	const results: RunResult[] = [];
	try {
		const statementStats = await enableStatementStats(connection.sql);
		await resetAndSeedIntegrationData(connection.sql);
		const repository = new BillingRepository(connection.db as never);
		await publishAiCreditsCatalog(repository);
		await seedAccounts(repository, options.accounts);
		if (options.scenarios.includes("users")) {
			// Fixture grants precede the load. Their initial snapshots are not usage traffic.
			await connection.sql`
				DELETE FROM projection_sync_jobs
				WHERE project_id = ${integrationProjectContext().projectInstanceId}
			`;
		}
		await printEnvironment(sampler, container, options);

		const startService = (workersEnabled: boolean) =>
			startBillingService(
				e2eServiceEnv({
					postgresUri,
					receiverUrl: receiver.url,
					overrides: {
						BILLING_METERING_RATE_LIMIT_PER_WINDOW: "1000000000",
						BILLING_WORKER_POLL_INTERVAL_MS: workersEnabled ? "250" : "3600000",
						BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS: "3600000",
						BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS: workersEnabled ? "60000" : "3600000",
					},
				}),
			);
		service = await startService(true);
		const client = createClient(service.baseUrl, apiKey);
		const context: ScenarioContext = {
			client,
			sql: connection.sql,
			sampler,
			receiver,
			options,
			statementStats,
			servicePid: service.pid,
			containerId: container?.getId() ?? null,
		};

		if (options.profile !== null) {
			await profileOperation(context, options.profile);
			return;
		}
		for (const scenario of options.scenarios) {
			if (scenario === "users") {
				for (const users of options.users) {
					results.push(await runUserScenario(context, users));
					// A failed arrival-rate level may leave server requests queued after client timeout.
					// Stop that process before the next level; all data belongs to the disposable fixture.
					await service.stop();
					await connection.sql`
						DELETE FROM projection_sync_jobs
						WHERE project_id = ${integrationProjectContext().projectInstanceId}
					`;
					service = await startService(true);
					context.client = createClient(service.baseUrl, apiKey);
					context.servicePid = service.pid;
				}
				continue;
			}
			if (scenario === "workers-off") {
				await service.stop();
				service = await startService(false);
				context.client = createClient(service.baseUrl, apiKey);
				context.servicePid = service.pid;
				const concurrency = Math.max(...options.concurrency);
				results.push(await runScenario(context, "workers-off", "hot", concurrency));
				results.push(await runScenario(context, "workers-off", "spread", concurrency));
				continue;
			}
			const levels =
				scenario === "reserve" || scenario === "check"
					? [...new Set([Math.min(...options.concurrency), Math.max(...options.concurrency)])]
					: options.concurrency;
			for (const concurrency of levels) {
				results.push(await runScenario(context, scenario, scenario, concurrency));
			}
		}
		printTable(results);
		const gateFailures = evaluateLoadGates(results, {
			minRps: options.minRps ?? undefined,
			maxP99Ms: options.maxP99Ms ?? undefined,
		});
		if (options.out !== null) {
			const report = {
				generatedAt: new Date().toISOString(),
				environment: {
					bun: Bun.version,
					platform: process.platform,
					cpus: cpus().length,
					totalMemoryGiB: round(totalmem() / 1024 ** 3),
					httpConcurrencyLimit: process.env.BUN_CONFIG_MAX_HTTP_REQUESTS ?? "Bun default",
					sourceRevision: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
					workingTreeDirty:
						Bun.spawnSync(["git", "status", "--porcelain"]).stdout.toString().trim() !== "",
				},
				options: {
					...options,
					postgresUri: options.postgresUri === null ? null : "[external disposable database]",
				},
				results,
				gateFailures,
			};
			await writeFile(options.out, `${JSON.stringify(report, null, "\t")}\n`);
			console.log(`\nResults written to ${options.out}`);
		}
		if (gateFailures.length > 0) {
			throw new Error(`Load lane gates failed:\n${gateFailures.join("\n")}`);
		}
	} finally {
		await service?.stop();
		receiver.stop();
		await sampler.close();
		await connection.sql.close();
		if (container !== undefined) {
			try {
				await container.stop();
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
			}
		}
	}
}

interface ScenarioContext {
	client: LoadClient;
	sql: SQL;
	sampler: SQL;
	receiver: CountingReceiver;
	options: Options;
	statementStats: boolean;
	servicePid: number;
	containerId: string | null;
}

async function runScenario(
	context: ScenarioContext,
	scenario: ScenarioKind,
	shape: "hot" | "spread" | "reserve" | "check",
	concurrency: number,
): Promise<RunResult> {
	const { client, options } = context;
	const account = (worker: number, iteration: number): string =>
		shape === "hot" ? hotAccount : `load-${(worker + iteration * concurrency) % options.accounts}`;
	const operation =
		shape === "reserve" ? "reserve+confirm" : shape === "check" ? "check" : "consume";
	const unitsPerCall = shape === "reserve" ? 100 : 1;
	const request = (worker: number, iteration: number): Promise<RequestOutcome> => {
		const billingAccountId = account(worker, iteration);
		if (shape === "check") return client.check(billingAccountId);
		if (shape === "reserve")
			return client.reserveAndConfirm(billingAccountId, String(unitsPerCall));
		return client.consume(billingAccountId);
	};

	process.stdout.write(`\n${scenario} (${operation}) concurrency=${concurrency} ... `);
	await drive(concurrency, options.warmupMs, request);
	const receiverBefore = context.receiver.count();
	const metricsBefore = await client.metrics();
	const dbBefore = await snapshotDb(context.sql, context.statementStats);
	const lockSampler = startLockSampler(context.sampler);
	const cpuSampler = startCpuSampler(context.servicePid, context.containerId);
	const startedAt = performance.now();
	const samples = await drive(concurrency, options.durationMs, request);
	const elapsedMs = performance.now() - startedAt;
	const lockWaits = await lockSampler.stop();
	const cpu = await cpuSampler.stop();
	const dbAfter = await snapshotDb(context.sql, context.statementStats);
	const metricsAfter = await client.metrics();
	const receiverAfter = context.receiver.count();
	const walMb = await walMegabytes(context.sql, dbBefore.walLsn, dbAfter.walLsn);

	const latencies = samples.map((sample) => sample.ms).sort((left, right) => left - right);
	const statuses: Record<string, number> = {};
	let denied = 0;
	let ledgerCalls = 0;
	for (const sample of samples) {
		statuses[String(sample.status)] = (statuses[String(sample.status)] ?? 0) + 1;
		if (sample.denied) denied += 1;
		ledgerCalls += sample.ledgerCalls;
	}
	const serverOperation = shape === "reserve" ? "confirm" : operation;
	const result: RunResult = {
		scenario,
		operation,
		concurrency,
		durationMs: Math.round(elapsedMs),
		requests: samples.length,
		ledgerCalls,
		unitsPerCall,
		rps: round(samples.length / (elapsedMs / 1000)),
		ledgerCallsPerSecond: round(ledgerCalls / (elapsedMs / 1000)),
		clientMs: {
			p50: round(percentile(latencies, 0.5)),
			p95: round(percentile(latencies, 0.95)),
			p99: round(percentile(latencies, 0.99)),
			max: round(latencies[latencies.length - 1] ?? 0),
		},
		serverMs: histogramDelta(metricsBefore, metricsAfter, serverOperation),
		statuses,
		denied,
		db: {
			xactPerSecond: round((dbAfter.xactCommit - dbBefore.xactCommit) / (elapsedMs / 1000)),
			walMb: round(walMb),
			deadTuplesDelta: dbAfter.deadTuples - dbBefore.deadTuples,
			lockWaitSamples: lockWaits,
			projectionJobsCreated: dbAfter.projectionJobs - dbBefore.projectionJobs,
			projectionDelivered: receiverAfter - receiverBefore,
			projectionBacklogAfter: dbAfter.projectionBacklog,
			statementsPerRequest:
				dbAfter.statementCalls === null || dbBefore.statementCalls === null || samples.length === 0
					? null
					: round((dbAfter.statementCalls - dbBefore.statementCalls) / samples.length),
			dbExecMsPerRequest:
				dbAfter.statementExecMs === null ||
				dbBefore.statementExecMs === null ||
				samples.length === 0
					? null
					: round((dbAfter.statementExecMs - dbBefore.statementExecMs) / samples.length),
		},
		cpu,
	};
	process.stdout.write(
		`${result.rps} rps, p50 ${result.clientMs.p50} ms, p99 ${result.clientMs.p99} ms, statuses ${JSON.stringify(statuses)}\n`,
	);
	return result;
}

async function runUserScenario(context: ScenarioContext, users: number): Promise<RunResult> {
	const { client, options } = context;
	console.log(`\nusers: ${users} independent billing accounts, 1 consume/user/second ...`);
	// Warm the HTTP/catalogue path without adding unmeasured usage or projection work.
	await drive(4, options.warmupMs, (worker, iteration) =>
		client.check(`load-${(iteration * 4 + worker) % users}`),
	);
	const prefix = `load-users:${crypto.randomUUID()}:`;
	const metricsBefore = await client.metrics();
	const dbBefore = await snapshotDb(context.sql, context.statementStats);
	const receiverBefore = context.receiver.count();
	const lockSampler = startLockSampler(context.sampler);
	const cpuSampler = startCpuSampler(context.servicePid, context.containerId);
	const run = await driveUserArrivals(
		{ users, durationMs: options.durationMs, maxInFlight: options.maxInFlight, maxLagMs: 100 },
		(account, index) =>
			client.consume(`load-${account}`, `${prefix}${index}`, options.requestTimeoutMs),
	);
	const [lockWaits, cpu] = await Promise.all([lockSampler.stop(), cpuSampler.stop()]);
	const dbAfter = await snapshotDb(context.sql, context.statementStats);
	const metricsAfter = await client.metrics();
	const receiverAfter = context.receiver.count();
	const latencies = run.samples.map((sample) => sample.ms).sort((a, b) => a - b);
	const scheduledLatencies = run.samples
		.map((sample) => sample.ms + sample.lagMs)
		.sort((a, b) => a - b);
	const lags = run.samples.map((sample) => sample.lagMs).sort((a, b) => a - b);
	const statuses: Record<string, number> = {};
	const acceptedKeys = new Set<string>();
	let acceptedDuringWindow = 0;
	let denied = 0;
	for (const sample of run.samples) {
		const status = String(sample.outcome?.status ?? 0);
		statuses[status] = (statuses[status] ?? 0) + 1;
		if (sample.outcome?.denied) denied += 1;
		if (sample.outcome?.accepted) {
			acceptedKeys.add(`${prefix}${sample.index}`);
			if (sample.finishedAtMs <= options.durationMs) acceptedDuringWindow += 1;
		}
	}
	const drainStartedAt = performance.now();
	let backlog = dbAfter.projectionBacklog;
	while (backlog > 0 && performance.now() - drainStartedAt < options.drainMs) {
		await Bun.sleep(250);
		const [row] = await context.sql<Array<{ backlog: number }>>`
			SELECT count(*)::int AS backlog FROM projection_sync_jobs
			WHERE status IN ('pending', 'processing', 'retrying')
		`;
		backlog = row?.backlog ?? backlog;
	}
	const projectionDrainMs = performance.now() - drainStartedAt;
	const accounting = await verifyUserAccounting(context.sql, prefix, users, acceptedKeys);
	const result: RunResult = {
		scenario: "users",
		operation: "consume",
		concurrency: run.peakInFlight,
		durationMs: Math.round(run.elapsedMs),
		requests: run.sent,
		ledgerCalls: run.sent,
		unitsPerCall: 1,
		rps: round(acceptedDuringWindow / (options.durationMs / 1000)),
		ledgerCallsPerSecond: round(run.sent / (options.durationMs / 1000)),
		clientMs: {
			p50: round(percentile(latencies, 0.5)),
			p95: round(percentile(latencies, 0.95)),
			p99: round(percentile(latencies, 0.99)),
			max: round(latencies.at(-1) ?? 0),
		},
		serverMs: histogramDelta(metricsBefore, metricsAfter, "consume"),
		statuses,
		denied,
		db: {
			xactPerSecond: round((dbAfter.xactCommit - dbBefore.xactCommit) / (run.elapsedMs / 1000)),
			walMb: round(await walMegabytes(context.sql, dbBefore.walLsn, dbAfter.walLsn)),
			deadTuplesDelta: dbAfter.deadTuples - dbBefore.deadTuples,
			lockWaitSamples: lockWaits,
			projectionJobsCreated: dbAfter.projectionJobs - dbBefore.projectionJobs,
			projectionDelivered: receiverAfter - receiverBefore,
			projectionBacklogAfter: backlog,
			statementsPerRequest:
				dbAfter.statementCalls === null || dbBefore.statementCalls === null || run.sent === 0
					? null
					: round((dbAfter.statementCalls - dbBefore.statementCalls) / run.sent),
			dbExecMsPerRequest:
				dbAfter.statementExecMs === null || dbBefore.statementExecMs === null || run.sent === 0
					? null
					: round((dbAfter.statementExecMs - dbBefore.statementExecMs) / run.sent),
		},
		cpu,
		arrivals: {
			users,
			windowMs: options.durationMs,
			scheduled: run.scheduled,
			sent: run.sent,
			droppedCapacity: run.droppedCapacity,
			droppedLate: run.droppedLate,
			peakInFlight: run.peakInFlight,
			inFlightAtEnd: run.inFlightAtEnd,
			accepted: acceptedKeys.size,
			acceptedDuringWindow,
			requestDrainMs: round(Math.max(0, run.elapsedMs - options.durationMs)),
			schedulingLagP99Ms: round(percentile(lags, 0.99)),
			scheduledLatencyP99Ms: round(percentile(scheduledLatencies, 0.99)),
			projectionBacklogBefore: dbBefore.projectionBacklog,
			projectionBacklogAtEnd: dbAfter.projectionBacklog,
			projectionDrainMs: round(projectionDrainMs),
			accounting,
		},
	};
	console.log(
		`- target ${users}/s; accepted during window ${result.rps}/s; accepted ${acceptedKeys.size}/${run.scheduled}; dropped ${run.droppedCapacity} capacity, ${run.droppedLate} generator; p99 ${result.clientMs.p99} ms`,
	);
	console.log(
		`- projections ${dbAfter.projectionBacklog} -> ${backlog} after ${round(projectionDrainMs)} ms drain; committed ${accounting.committed}, missing accepted ${accounting.missingAccepted}, invalid events ${accounting.invalidEvents}`,
	);
	return result;
}

/** Check every successful reply against its durable claim and customer-scoped usage fact. */
async function verifyUserAccounting(
	sql: SQL,
	prefix: string,
	users: number,
	acceptedKeys: ReadonlySet<string>,
): Promise<{ committed: number; missingAccepted: number; invalidEvents: number }> {
	const rows = await sql<Array<{ key: string; account: string; valid: boolean }>>`
		SELECT claim.idempotency_key AS key, customer.billing_account_id AS account,
			(event.id IS NOT NULL AND event.customer_id = claim.customer_id
				AND event.operation = 'consume' AND event.quantity = 1
				AND event.wallet_quantity = (claim.outcome->>'walletQuantity')::numeric) AS valid
		FROM client_idempotency_claims claim
		JOIN customers customer ON customer.project_id = claim.project_id AND customer.id = claim.customer_id
		LEFT JOIN usage_events event ON event.project_id = claim.project_id
			AND event.id = (claim.outcome->>'usageEventId')::uuid
			AND event.recorded_at = (claim.outcome->>'recordedAt')::timestamptz
		WHERE claim.project_id = ${integrationProjectContext().projectInstanceId}
			AND claim.operation = 'consume' AND claim.idempotency_key LIKE ${`${prefix}%`}
			AND claim.outcome->>'allowed' = 'true'
	`;
	const committed = new Set<string>();
	let invalidEvents = 0;
	for (const row of rows) {
		committed.add(row.key);
		const index = Number(row.key.slice(prefix.length));
		if (!row.valid || row.account !== `load-${index % users}`) invalidEvents += 1;
	}
	return {
		committed: rows.length,
		missingAccepted: [...acceptedKeys].filter((key) => !committed.has(key)).length,
		invalidEvents,
	};
}

/** Lists every statement one hot request executes, from pg_stat_statements, with mean times. */
async function profileOperation(
	context: ScenarioContext,
	operation: "consume" | "check" | "reserve",
): Promise<void> {
	const request = () =>
		operation === "check"
			? context.client.check(hotAccount)
			: operation === "reserve"
				? context.client.reserveAndConfirm(hotAccount, "100")
				: context.client.consume(hotAccount);
	if (!context.statementStats) throw new Error("--profile needs pg_stat_statements");
	const warmup = 20;
	const measured = 50;
	for (let index = 0; index < warmup; index += 1) await request();
	await context.sql`SELECT pg_stat_statements_reset()`;
	const startedAt = performance.now();
	for (let index = 0; index < measured; index += 1) await request();
	const wallMs = (performance.now() - startedAt) / measured;
	const rows = await context.sql<
		Array<{ calls: number; rows: number; mean_ms: number; total_ms: number; query: string }>
	>`
		SELECT calls::int AS calls, rows::int AS rows, mean_exec_time AS mean_ms,
			total_exec_time AS total_ms, query
		FROM pg_stat_statements
		WHERE calls >= ${Math.floor(measured * 0.9)} AND query NOT ILIKE '%pg_stat%'
		ORDER BY total_exec_time DESC
	`;
	const statements = rows.reduce((sum, row) => sum + row.calls, 0) / measured;
	const execMs = rows.reduce((sum, row) => sum + row.total_ms, 0) / measured;
	console.log(`\nProfile of one hot ${operation} over ${measured} sequential requests`);
	console.log(
		`- wall ${round(wallMs)} ms per ${operation}, ${round(statements)} statements, ${round(execMs)} ms Postgres execution`,
	);
	console.log("\n| Calls/request | Rows | Mean ms | Statement |");
	console.log("| ---: | ---: | ---: | --- |");
	for (const row of rows) {
		const text = row.query.replaceAll(/\s+/g, " ").trim();
		console.log(
			`| ${round(row.calls / measured)} | ${round(row.rows / measured)} | ${round(row.mean_ms * 100) / 100} | ${text.length > 170 ? `${text.slice(0, 170)}…` : text} |`,
		);
	}
}

interface RequestOutcome {
	status: number;
	denied: boolean;
	ledgerCalls: number;
	accepted?: boolean;
}

interface Sample extends RequestOutcome {
	ms: number;
}

async function drive(
	concurrency: number,
	durationMs: number,
	request: (worker: number, iteration: number) => Promise<RequestOutcome>,
): Promise<Sample[]> {
	const deadline = performance.now() + durationMs;
	const samples: Sample[] = [];
	const workers = Array.from({ length: concurrency }, async (_, worker) => {
		let iteration = 0;
		while (performance.now() < deadline) {
			const startedAt = performance.now();
			let outcome: RequestOutcome;
			try {
				outcome = await request(worker, iteration);
			} catch {
				outcome = { status: 0, denied: false, ledgerCalls: 0 };
			}
			samples.push({ ...outcome, ms: performance.now() - startedAt });
			iteration += 1;
		}
	});
	await Promise.all(workers);
	return samples;
}

interface LoadClient {
	consume(
		billingAccountId: string,
		operationId?: string,
		timeoutMs?: number,
	): Promise<RequestOutcome>;
	check(billingAccountId: string): Promise<RequestOutcome>;
	reserveAndConfirm(billingAccountId: string, quantity: string): Promise<RequestOutcome>;
	metrics(): Promise<string>;
}

function createClient(baseUrl: string, apiKey: string): LoadClient {
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	};
	const post = async (
		path: string,
		body: Record<string, unknown>,
		idempotent: boolean,
		operationId?: string,
		timeoutMs?: number,
	): Promise<{ status: number; data: Record<string, unknown> | null }> => {
		const response = await fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers: idempotent
				? { ...headers, "Idempotency-Key": operationId ?? crypto.randomUUID() }
				: headers,
			body: JSON.stringify(body),
			signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
		});
		const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
		const data =
			payload !== null && typeof payload.data === "object" && payload.data !== null
				? (payload.data as Record<string, unknown>)
				: null;
		return { status: response.status, data };
	};
	const usage = (billingAccountId: string) =>
		`/v1/billing-accounts/${encodeURIComponent(billingAccountId)}/usage`;
	return {
		async consume(billingAccountId, operationId, timeoutMs) {
			const { status, data } = await post(
				`${usage(billingAccountId)}/consume`,
				{ featureKey: "model_tokens", quantity: "1" },
				true,
				operationId,
				timeoutMs,
			);
			return {
				status,
				denied: data?.allowed === false,
				accepted: status === 200 && data?.allowed === true,
				ledgerCalls: 1,
			};
		},
		async check(billingAccountId) {
			const { status, data } = await post(
				`${usage(billingAccountId)}/check`,
				{ featureKey: "model_tokens", quantity: "1" },
				false,
			);
			return { status, denied: data?.allowed === false, ledgerCalls: 1 };
		},
		async reserveAndConfirm(billingAccountId, quantity) {
			const reserved = await post(
				`${usage(billingAccountId)}/reservations`,
				{ featureKey: "model_tokens", quantity, expiresInSeconds: 60 },
				true,
			);
			const reservationId = reserved.data?.reservationId;
			if (reserved.status !== 200 || typeof reservationId !== "string") {
				return {
					status: reserved.status,
					denied: reserved.data?.allowed === false,
					ledgerCalls: 1,
				};
			}
			const confirmed = await post(
				`${usage(billingAccountId)}/reservations/${reservationId}/confirm`,
				{ quantity },
				true,
			);
			return {
				status: confirmed.status,
				denied: confirmed.data?.allowed === false,
				ledgerCalls: 2,
			};
		},
		async metrics() {
			return await (await fetch(`${baseUrl}/metrics`)).text();
		},
	};
}

interface CountingReceiver {
	url: string;
	count(): number;
	stop(): void;
}

function createCountingReceiver(): CountingReceiver {
	let delivered = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			await request.arrayBuffer();
			delivered += 1;
			return Response.json({ success: true });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		count: () => delivered,
		stop: () => server.stop(true),
	};
}

async function seedAccounts(repository: BillingRepository, accounts: number): Promise<void> {
	const project = integrationProjectContext();
	const grant = (billingAccountId: string) =>
		repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "1000000000",
			sourceKind: "operator",
			sourceKey: `load-lane:${billingAccountId}`,
		});
	await grant(hotAccount);
	const batch = 25;
	for (let start = 0; start < accounts; start += batch) {
		await Promise.all(
			Array.from({ length: Math.min(batch, accounts - start) }, (_, offset) =>
				grant(`load-${start + offset}`),
			),
		);
	}
}

async function snapshotDb(sql: SQL, statementStats: boolean): Promise<DbSnapshot> {
	const [row] = await sql<
		Array<{
			xact_commit: string | number;
			wal_lsn: string;
			dead_tuples: string | number;
			projection_jobs: string | number;
			projection_backlog: string | number;
		}>
	>`
		SELECT
			(SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()) AS xact_commit,
			pg_current_wal_lsn()::text AS wal_lsn,
			(SELECT coalesce(sum(n_dead_tup), 0) FROM pg_stat_user_tables
				WHERE relname IN ('balance_allocations', 'client_idempotency_claims', 'usage_windows',
					'projection_sync_jobs', 'reservations', 'reservation_allocations')
					OR relname LIKE 'usage_events%') AS dead_tuples,
			(SELECT count(*) FROM projection_sync_jobs) AS projection_jobs,
			(SELECT count(*) FROM projection_sync_jobs WHERE status IN ('pending', 'processing')) AS projection_backlog
	`;
	if (row === undefined) throw new Error("Postgres statistics snapshot returned no row");
	let statementCalls: number | null = null;
	let statementExecMs: number | null = null;
	if (statementStats) {
		const [stats] = await sql<Array<{ calls: string | number; exec_ms: string | number }>>`
			SELECT coalesce(sum(calls), 0) AS calls, coalesce(sum(total_exec_time), 0) AS exec_ms
			FROM pg_stat_statements
		`;
		statementCalls = Number(stats?.calls ?? 0);
		statementExecMs = Number(stats?.exec_ms ?? 0);
	}
	return {
		xactCommit: Number(row.xact_commit),
		walLsn: row.wal_lsn,
		deadTuples: Number(row.dead_tuples),
		projectionJobs: Number(row.projection_jobs),
		projectionBacklog: Number(row.projection_backlog),
		statementCalls,
		statementExecMs,
	};
}

async function enableStatementStats(sql: SQL): Promise<boolean> {
	try {
		await sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`;
		await sql`SELECT pg_stat_statements_reset()`;
		return true;
	} catch {
		console.log("- pg_stat_statements unavailable; statements per request will be n/a");
		return false;
	}
}

function startCpuSampler(
	servicePid: number,
	containerId: string | null,
): { stop(): Promise<{ servicePercent: number | null; postgresPercent: number | null }> } {
	const service: number[] = [];
	const postgres: number[] = [];
	let active = true;
	const read = async (command: string[]): Promise<number | null> => {
		try {
			const text = await new Response(Bun.spawn(command, { stderr: "ignore" }).stdout).text();
			const value = Number.parseFloat(text.trim().replace("%", ""));
			return Number.isFinite(value) ? value : null;
		} catch {
			return null;
		}
	};
	const loop = (async () => {
		while (active) {
			const [serviceCpu, postgresCpu] = await Promise.all([
				read(["ps", "-o", "%cpu=", "-p", String(servicePid)]),
				containerId === null
					? Promise.resolve(null)
					: read(["docker", "stats", "--no-stream", "--format", "{{.CPUPerc}}", containerId]),
			]);
			if (serviceCpu !== null) service.push(serviceCpu);
			if (postgresCpu !== null) postgres.push(postgresCpu);
			await Bun.sleep(1000);
		}
	})();
	const mean = (values: number[]): number | null =>
		values.length === 0
			? null
			: round(values.reduce((sum, value) => sum + value, 0) / values.length);
	return {
		async stop() {
			active = false;
			await loop;
			return { servicePercent: mean(service), postgresPercent: mean(postgres) };
		},
	};
}

async function walMegabytes(sql: SQL, before: string, after: string): Promise<number> {
	const [row] = await sql<Array<{ bytes: string | number }>>`
		SELECT pg_wal_lsn_diff(${after}::pg_lsn, ${before}::pg_lsn) AS bytes
	`;
	return Number(row?.bytes ?? 0) / (1024 * 1024);
}

function startLockSampler(sql: SQL): { stop(): Promise<{ max: number; mean: number }> } {
	const samples: number[] = [];
	let active = true;
	const loop = (async () => {
		while (active) {
			try {
				const [row] = await sql<Array<{ waiting: number }>>`
					SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock'
				`;
				samples.push(row?.waiting ?? 0);
			} catch {
				samples.push(0);
			}
			await Bun.sleep(250);
		}
	})();
	return {
		async stop() {
			active = false;
			await loop;
			const max = samples.length === 0 ? 0 : Math.max(...samples);
			const mean =
				samples.length === 0 ? 0 : samples.reduce((sum, value) => sum + value, 0) / samples.length;
			return { max, mean: round(mean) };
		},
	};
}

function histogramDelta(
	before: string,
	after: string,
	operation: string,
): { p50: number | null; p99: number | null; count: number } {
	const parse = (text: string): Map<number, number> => {
		const buckets = new Map<number, number>();
		const pattern = /^billing_metering_operation_duration_ms_bucket\{([^}]*)\} (\d+)$/;
		for (const line of text.split("\n")) {
			const match = pattern.exec(line);
			if (match === null) continue;
			const labels = Object.fromEntries(
				match[1].split(",").map((pair) => {
					const [key, value] = pair.split("=");
					return [key, (value ?? "").replaceAll('"', "")];
				}),
			);
			if (labels.operation !== operation || labels.result !== "completed") continue;
			const upper = labels.le === "+Inf" ? Number.POSITIVE_INFINITY : Number(labels.le);
			buckets.set(upper, (buckets.get(upper) ?? 0) + Number(match[2]));
		}
		return buckets;
	};
	const first = parse(before);
	const second = parse(after);
	const bounds = [...second.keys()].sort((left, right) => left - right);
	const total =
		(second.get(Number.POSITIVE_INFINITY) ?? 0) - (first.get(Number.POSITIVE_INFINITY) ?? 0);
	const quantile = (q: number): number | null => {
		if (total <= 0) return null;
		for (const bound of bounds) {
			const cumulative = (second.get(bound) ?? 0) - (first.get(bound) ?? 0);
			if (cumulative >= total * q) return bound;
		}
		return null;
	};
	return { p50: quantile(0.5), p99: quantile(0.99), count: total };
}

function percentile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
	return sorted[index] ?? 0;
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

async function printEnvironment(
	sql: SQL,
	container: StartedPostgreSqlContainer | undefined,
	options: Options,
): Promise<void> {
	const [row] = await sql<Array<{ version: string }>>`SELECT version() AS version`;
	console.log("Load lane environment");
	console.log(
		`- Bun ${Bun.version}, ${cpus().length} CPUs, ${round(totalmem() / 1024 ** 3)} GiB RAM`,
	);
	console.log(
		`- Postgres: ${row?.version ?? "unknown"}${container ? " (testcontainers, default config)" : ""}`,
	);
	console.log(
		`- duration ${options.durationMs} ms, warmup ${options.warmupMs} ms, concurrency ${options.concurrency.join("/")}, accounts ${options.accounts}, scenarios ${options.scenarios.join(",")}`,
	);
	if (options.pgConfig.length > 0)
		console.log(`- extra Postgres settings: ${options.pgConfig.join(", ")}`);
	console.log(
		"- Client, service and Postgres share this machine; treat results as shapes, not capacity.",
	);
}

function printTable(results: readonly RunResult[]): void {
	const userResults = results.filter((result) => result.arrivals !== undefined);
	if (userResults.length > 0) {
		console.log(
			"\n| Users / requested RPS | Accepted RPS in window | Accepted / scheduled | Capacity drops | Generator drops | Client p99 ms | Projection backlog after drain |",
		);
		console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
		for (const result of userResults) {
			const arrivals = result.arrivals;
			if (arrivals === undefined) continue;
			console.log(
				`| ${arrivals.users} | ${result.rps} | ${arrivals.accepted}/${arrivals.scheduled} | ${arrivals.droppedCapacity} | ${arrivals.droppedLate} | ${result.clientMs.p99} | ${result.db.projectionBacklogAfter} |`,
			);
		}
	}
	console.log(
		"\n| Scenario | Operation | Conc. | RPS | Ledger calls/s | Client p50 ms | Client p99 ms | Server p99 ms (bucket) | Errors | Denied | Xact/s | WAL MB | Dead tuples | Lock waits max/mean | Proj. created | Proj. delivered | Proj. backlog | Stmts/req | DB ms/req | Service CPU % | PG CPU % |",
	);
	console.log(
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	);
	for (const result of results) {
		const errors = Object.entries(result.statuses)
			.filter(([status]) => Number(status) >= 400 || Number(status) === 0)
			.map(([status, count]) => `${status}:${count}`)
			.join(" ");
		console.log(
			`| ${result.scenario} | ${result.operation} | ${result.concurrency} | ${result.rps} | ${result.ledgerCallsPerSecond} | ${result.clientMs.p50} | ${result.clientMs.p99} | ${result.serverMs.p99 ?? "n/a"} | ${errors === "" ? "none" : errors} | ${result.denied} | ${result.db.xactPerSecond} | ${result.db.walMb} | ${result.db.deadTuplesDelta} | ${result.db.lockWaitSamples.max}/${result.db.lockWaitSamples.mean} | ${result.db.projectionJobsCreated} | ${result.db.projectionDelivered} | ${result.db.projectionBacklogAfter} | ${result.db.statementsPerRequest ?? "n/a"} | ${result.db.dbExecMsPerRequest ?? "n/a"} | ${result.cpu.servicePercent ?? "n/a"} | ${result.cpu.postgresPercent ?? "n/a"} |`,
		);
	}
}

function parseOptions(argv: readonly string[]): Options {
	const options: Options = {
		durationMs: 10_000,
		warmupMs: 1_000,
		concurrency: [...defaultConcurrency],
		accounts: 1000,
		scenarios: [...defaultScenarios],
		out: null,
		postgresUri: process.env.POSTGRES_URI ?? null,
		pgConfig: [],
		profile: null,
		recreateSchema: false,
		minRps: null,
		maxP99Ms: null,
		users: [100, 1000, 2000, 5000, 10000],
		maxInFlight: 2000,
		requestTimeoutMs: 5000,
		drainMs: 10000,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		const requireValue = (): string => {
			if (value === undefined) throw new Error(`${flag} requires a value`);
			index += 1;
			return value;
		};
		switch (flag) {
			case "--duration":
				options.durationMs = Math.round(Number(requireValue()) * 1000);
				break;
			case "--warmup":
				options.warmupMs = Math.round(Number(requireValue()) * 1000);
				break;
			case "--concurrency":
				options.concurrency = requireValue()
					.split(",")
					.map((item) => Number(item.trim()))
					.filter((item) => Number.isInteger(item) && item > 0);
				break;
			case "--accounts":
				options.accounts = Number(requireValue());
				break;
			case "--scenarios":
				options.scenarios = requireValue()
					.split(",")
					.map((item) => item.trim())
					.filter((item): item is ScenarioKind => [...defaultScenarios, "users"].includes(item));
				break;
			case "--out":
				options.out = requireValue();
				break;
			case "--postgres-uri":
				options.postgresUri = requireValue();
				break;
			case "--docker":
				options.postgresUri = null;
				break;
			case "--pg-config":
				options.pgConfig = [...options.pgConfig, requireValue()];
				break;
			case "--recreate-schema":
				options.recreateSchema = true;
				break;
			case "--min-rps":
				options.minRps = Number(requireValue());
				break;
			case "--max-p99-ms":
				options.maxP99Ms = Number(requireValue());
				break;
			case "--users":
				options.users = requireValue().split(",").map(Number);
				break;
			case "--max-in-flight":
				options.maxInFlight = Number(requireValue());
				break;
			case "--request-timeout-ms":
				options.requestTimeoutMs = Number(requireValue());
				break;
			case "--drain-seconds":
				options.drainMs = Number(requireValue()) * 1000;
				break;
			case "--profile": {
				const next = argv[index + 1];
				if (next === "check" || next === "consume" || next === "reserve") {
					options.profile = next;
					index += 1;
				} else {
					options.profile = "consume";
				}
				break;
			}
			case "--help":
				console.log(
					"bun run test:load [--duration s] [--warmup s] [--concurrency 1,8,32,64] [--accounts n] [--scenarios hot,spread,reserve,check,workers-off,users] [--users 100,1000,2000,5000,10000] [--max-in-flight 2000] [--request-timeout-ms 5000] [--drain-seconds 10] [--min-rps n] [--max-p99-ms n] [--out file.json] [--docker | --postgres-uri uri] [--pg-config setting=value ...] [--profile [consume|check|reserve]] [--recreate-schema]",
				);
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown option ${flag}`);
		}
	}
	if (options.concurrency.length === 0) throw new Error("--concurrency needs at least one level");
	if (!Number.isInteger(options.accounts) || options.accounts < 1)
		throw new Error("--accounts must be a positive integer");
	if (options.scenarios.length === 0) throw new Error("--scenarios selected nothing");
	for (const [name, value] of Object.entries({
		duration: options.durationMs,
		"max-in-flight": options.maxInFlight,
		"request-timeout-ms": options.requestTimeoutMs,
		"drain-seconds": options.drainMs,
	})) {
		if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be positive`);
	}
	if (!Number.isFinite(options.warmupMs) || options.warmupMs < 0)
		throw new Error("--warmup must be nonnegative");
	if (
		options.users.length === 0 ||
		options.users.some((value) => !Number.isInteger(value) || value < 1)
	)
		throw new Error("--users must contain positive integer user counts");
	if (options.scenarios.includes("users")) {
		options.accounts = Math.max(options.accounts, ...options.users);
	}
	return options;
}
