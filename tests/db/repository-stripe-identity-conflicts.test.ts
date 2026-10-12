import { describe, expect, it } from "bun:test";
import { BillingRepository } from "../../src/db/repository";
import {
	IdentityConflictError,
	isStripeIdentityConflictReason,
	stripeIdentityConflictReason,
} from "../../src/db/repository/identity-conflicts";
import { renderDrizzleSql } from "../helpers/drizzle-sql";
import { projectInstanceContext } from "../helpers/project-context";
import { stripeSubscriptionInput } from "./repository-fixture";

/** Answers the scripted rows in order; an error in the script is thrown by that statement. */
class ScriptedDatabase {
	readonly queries: string[] = [];
	constructor(private readonly script: Array<Array<Record<string, unknown>> | Error>) {}

	async execute(query: unknown) {
		this.queries.push(renderDrizzleSql(query));
		const next = this.script.shift();
		if (next instanceof Error) throw next;
		return next ?? [];
	}

	async transaction<T>(callback: (tx: ScriptedDatabase) => Promise<T>): Promise<T> {
		return await callback(this);
	}
}

const resolvedCustomer = [{ id: "customer-1", billing_account_id: "user-1", created: false }];
const storedEventRow = [{ id: "store-event-id" }];

describe("Stripe identity conflicts in the repository", () => {
	it("keeps an event naming a second customer for the account as a skipped event", async () => {
		// The link statement inserts nothing, and the account turns out to hold another customer.
		const database = new ScriptedDatabase([
			resolvedCustomer,
			[],
			[{ customer_id: "customer-1", external_customer_id: "cus_old" }],
			storedEventRow,
		]);
		const repository = new BillingRepository(database as never);

		const result = await repository.recordStripeSubscriptionAndEnqueueProjection(
			projectInstanceContext("globex"),
			stripeSubscriptionInput(),
		);

		expect(result).toEqual({
			processingStatus: "skipped",
			billingAccountId: null,
			entitlements: null,
			skipReason: "stripe_account_linked_to_other_customer",
		});
		const queries = database.queries.join("\n");
		expect(queries).toContain(
			"stripe_account_linked_to_other_customer: billing account is linked to Stripe customer cus_old; the event names Stripe customer cus_123",
		);
		expect(queries).toContain("INSERT INTO store_events");
		expect(queries).not.toContain("INSERT INTO subscriptions");
	});

	it("keeps an event naming a customer another account holds as a skipped event", async () => {
		const database = new ScriptedDatabase([
			resolvedCustomer,
			[],
			[{ customer_id: "customer-2", external_customer_id: "cus_123" }],
			storedEventRow,
		]);
		const repository = new BillingRepository(database as never);

		const result = await repository.recordStripeSubscriptionAndEnqueueProjection(
			projectInstanceContext("globex"),
			stripeSubscriptionInput(),
		);

		expect(result).toMatchObject({
			processingStatus: "skipped",
			skipReason: "stripe_customer_linked_to_other_account",
		});
		expect(database.queries.join("\n")).toContain(
			"stripe_customer_linked_to_other_account: provider customer identity mismatch for Stripe customer id cus_123",
		);
	});

	it("keeps an event whose link vanished while it was checked as a skipped event to replay", async () => {
		// Nothing was inserted and nothing explains it any more: the replay decides again.
		const database = new ScriptedDatabase([resolvedCustomer, [], [], storedEventRow]);
		const repository = new BillingRepository(database as never);

		const result = await repository.recordStripeSubscriptionAndEnqueueProjection(
			projectInstanceContext("globex"),
			stripeSubscriptionInput(),
		);

		expect(result).toMatchObject({
			processingStatus: "skipped",
			skipReason: "stripe_customer_linked_to_other_account",
		});
	});

	it("treats the unique index on one Stripe customer per account as the same conflict", async () => {
		const uniqueViolation = Object.assign(new Error("duplicate key value"), { errno: "23505" });
		const database = new ScriptedDatabase([resolvedCustomer, uniqueViolation, storedEventRow]);
		const repository = new BillingRepository(database as never);

		const result = await repository.recordStripeSubscriptionAndEnqueueProjection(
			projectInstanceContext("globex"),
			stripeSubscriptionInput(),
		);

		expect(result).toMatchObject({
			processingStatus: "skipped",
			skipReason: "stripe_account_linked_to_other_customer",
		});
		expect(database.queries.join("\n")).toContain(
			"billing account is linked to another Stripe customer; the event names Stripe customer cus_123",
		);
	});

	it("does not take another failure for an identity conflict", async () => {
		const database = new ScriptedDatabase([resolvedCustomer, new Error("connection reset")]);
		const repository = new BillingRepository(database as never);

		await expect(
			repository.recordStripeSubscriptionAndEnqueueProjection(
				projectInstanceContext("globex"),
				stripeSubscriptionInput(),
			),
		).rejects.toThrow("connection reset");
		expect(database.queries.join("\n")).not.toContain("INSERT INTO store_events");
	});

	it("keeps a conflict of a live provider read as an error", async () => {
		const database = new ScriptedDatabase([
			resolvedCustomer,
			[],
			[{ customer_id: "customer-1", external_customer_id: "cus_old" }],
		]);
		const repository = new BillingRepository(database as never);

		await expect(
			repository.recordStripeSubscriptionAndEnqueueProjection(
				projectInstanceContext("globex"),
				stripeSubscriptionInput({ externalEventId: null }),
			),
		).rejects.toBeInstanceOf(IdentityConflictError);
		expect(database.queries.join("\n")).not.toContain("INSERT INTO store_events");
	});
});

describe("Stripe identity conflict reasons", () => {
	it("names a conflict after its kind and recognizes only those reasons", () => {
		const reason = stripeIdentityConflictReason(
			new IdentityConflictError("event_identity_changed", "changed"),
		);

		expect(reason).toBe("stripe_event_identity_changed");
		expect(isStripeIdentityConflictReason(reason)).toBe(true);
		expect(isStripeIdentityConflictReason("stripe_reversal_payment_unmatched")).toBe(false);
		expect(isStripeIdentityConflictReason("stripe_recording_skipped")).toBe(false);
		expect(isStripeIdentityConflictReason(undefined)).toBe(false);
	});
});
