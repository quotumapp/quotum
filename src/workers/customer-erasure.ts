import type {
	CustomerErasureRunOptions,
	CustomerErasureRunOutcome,
} from "../db/repository/customer-erasures";
import {
	type BillingLogger,
	createNoopBillingLogger,
	safelyLogError,
	safelyLogInfo,
} from "../observability/logger";

export interface CustomerErasureRepository {
	runNextCustomerErasure(options: CustomerErasureRunOptions): Promise<CustomerErasureRunOutcome>;
	sweepCustomerErasures(limit: number): Promise<number>;
}

export interface CustomerErasureRunResult {
	progressed: number;
	completed: number;
	failed: number;
	swept: number;
}

/**
 * Works erasures that a request froze: deletes and scrubs the account's rows in bounded batches
 * under a lease, then verifies that nothing still carries the original id. It also sweeps expired
 * tombstones. Every step is idempotent, so a worker that stops mid-batch is resumed by any other.
 */
export class CustomerErasureWorker {
	private readonly repository: CustomerErasureRepository;
	private readonly workerId: string;
	private readonly batchSize: number;
	private readonly budgetMs: number;
	private readonly leaseSeconds: number;
	private readonly maxClaims: number;
	private readonly sweepIntervalMs: number;
	private readonly now: () => number;
	private readonly logger: BillingLogger;
	private lastSweepAt = 0;

	constructor({
		repository,
		workerId,
		batchSize = 500,
		budgetMs = 15_000,
		leaseSeconds = 300,
		maxClaims = 5,
		sweepIntervalMs = 60_000,
		now = () => Date.now(),
		logger = createNoopBillingLogger(),
	}: {
		repository: CustomerErasureRepository;
		workerId: string;
		batchSize?: number;
		budgetMs?: number;
		leaseSeconds?: number;
		maxClaims?: number;
		sweepIntervalMs?: number;
		now?: () => number;
		logger?: BillingLogger;
	}) {
		if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
			throw new Error("Customer erasure batch size must be between 1 and 5000");
		}
		if (leaseSeconds * 1000 <= budgetMs) {
			throw new Error("Customer erasure lease must outlast its time budget");
		}
		this.repository = repository;
		this.workerId = workerId;
		this.batchSize = batchSize;
		this.budgetMs = budgetMs;
		this.leaseSeconds = leaseSeconds;
		this.maxClaims = maxClaims;
		this.sweepIntervalMs = sweepIntervalMs;
		this.now = now;
		this.logger = logger;
	}

	async runOnce(): Promise<CustomerErasureRunResult> {
		const result: CustomerErasureRunResult = { progressed: 0, completed: 0, failed: 0, swept: 0 };
		try {
			for (let claim = 0; claim < this.maxClaims; claim += 1) {
				const outcome = await this.repository.runNextCustomerErasure({
					workerId: this.workerId,
					batchSize: this.batchSize,
					budgetMs: this.budgetMs,
					leaseSeconds: this.leaseSeconds,
				});
				if (outcome.kind === "idle") break;
				result[outcome.kind] += 1;
				// Ids only: the operation row, never the account it was for.
				safelyLogInfo(this.logger, "Customer erasure worked", {
					erasureId: outcome.erasureId,
					outcome: outcome.kind,
				});
			}
			// Expiry is measured in days, so a minute's resolution is plenty and an idle poll stays cheap.
			const now = this.now();
			if (now - this.lastSweepAt >= this.sweepIntervalMs) {
				this.lastSweepAt = now;
				result.swept = await this.repository.sweepCustomerErasures(this.batchSize);
			}
			return result;
		} catch (error) {
			safelyLogError(this.logger, "Customer erasure run failed", error, {
				worker: "customer_erasure",
			});
			throw error;
		}
	}
}
