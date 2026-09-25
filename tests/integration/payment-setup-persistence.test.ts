import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { isBillingError } from "../../src/billing/errors";
import { sqlstateOf } from "../../src/db/postgres-errors";
import type { ReservePaymentSetupInput } from "../../src/db/repository";
import { paymentSetupSessions } from "../../src/db/schema";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const voysee = integrationProjectContext("voysee");
const wiseley = integrationProjectContext("wiseley");
let context: LocalPostgresContext;

const hour = 60 * 60 * 1000;

/** A constraint failure's message, without walking the driver's circular error object. */
async function expectConstraint(
	query: Promise<unknown>,
	constraint: string | RegExp,
): Promise<void> {
	try {
		await query;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (typeof constraint === "string") {
			expect(message).toContain(constraint);
		} else {
			expect(message).toMatch(constraint);
		}
		return;
	}
	throw new Error(`Expected ${String(constraint)}`);
}

function reservation(overrides: Partial<ReservePaymentSetupInput> = {}): ReservePaymentSetupInput {
	return {
		billingAccountId: "setup_account",
		previewToken: "11111111-1111-4111-8111-111111111111",
		providerAccountId: "acct_stripe_1",
		providerCustomerId: "cus_setup",
		providerIdempotencyKey: "billing:payment-setup:voysee:abc",
		requestHash: "a".repeat(64),
		currency: "usd",
		email: null,
		successUrl: "https://app.integration.test/billing",
		cancelUrl: "https://app.integration.test/billing",
		expiresAt: new Date(Date.now() + 24 * hour),
		plan: null,
		...overrides,
	};
}

/**
 * The real statements behind hosted payment setup. The provider tests use an in-memory stand-in;
 * these exercise the CHECK constraints, the single-slot partial index and the claim lease.
 */
localDescribe("Payment setup persistence", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("moves one setup through creating, applying and completed", async () => {
		const created = await context.repository.reservePaymentSetup(voysee, reservation());
		expect(created.kind).toBe("created");
		expect(created.setup.status).toBe("creating");

		const linked = await context.repository.recordPaymentSetupLink(voysee, {
			setupId: created.setup.id,
			externalSessionId: "cs_setup_1",
			sessionUrl: "https://checkout.stripe.test/setup/cs_setup_1",
			externalSetupIntentId: null,
			expiresAt: new Date(Date.now() + 24 * hour),
		});
		expect(linked.status).toBe("awaiting_customer");

		const claimed = await context.repository.claimPaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
		});
		expect(claimed?.claimed_by).toBe("worker-a");
		// A second worker cannot take a fresh claim.
		expect(
			await context.repository.claimPaymentSetup(voysee, {
				setupId: created.setup.id,
				workerId: "worker-b",
			}),
		).toBeNull();

		const applying = await context.repository.recordPaymentSetupIntent(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
			externalSetupIntentId: "seti_1",
			paymentMethodId: "pm_1",
			externalSessionId: "cs_setup_1",
		});
		expect(applying.status).toBe("applying_default");
		expect(applying.intended_payment_method_id).toBe("pm_1");
		expect(applying.default_payment_method_id).toBeNull();

		const completed = await context.repository.completePaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
			paymentMethodId: "pm_1",
			card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2031 },
		});
		expect(completed.status).toBe("completed");
		expect(completed.claimed_by).toBeNull();
		expect(
			(await context.repository.getPaymentSetupSession(voysee, "setup_account", created.setup.id))
				.url,
		).toBeNull();

		const session = await context.repository.getPaymentSetupSession(
			voysee,
			"setup_account",
			"cs_setup_1",
		);
		expect(session).toMatchObject({
			setupId: created.setup.id,
			status: "completed",
			url: null,
			card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2031 },
		});
	});

	it("applies a completion that overtook the creation response", async () => {
		const created = await context.repository.reservePaymentSetup(voysee, reservation());
		await context.repository.claimPaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
		});

		// The row is still `creating`; the event carries the session identity it has not stored.
		const applying = await context.repository.recordPaymentSetupIntent(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
			externalSetupIntentId: "seti_race",
			paymentMethodId: "pm_race",
			externalSessionId: "cs_setup_race",
		});
		expect(applying.status).toBe("applying_default");
		expect(applying.external_session_id).toBe("cs_setup_race");

		await context.repository.completePaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
			paymentMethodId: "pm_race",
			card: null,
		});

		// The creation response lands afterwards and never drags the setup back.
		const linked = await context.repository.recordPaymentSetupLink(voysee, {
			setupId: created.setup.id,
			externalSessionId: "cs_setup_race",
			sessionUrl: "https://checkout.stripe.test/setup/cs_setup_race",
			externalSetupIntentId: null,
			expiresAt: new Date(Date.now() + 24 * hour),
		});
		expect(linked.status).toBe("completed");
		expect(linked.session_url).toBeNull();
		expect(new Date(linked.expires_at).toISOString()).toBe(
			new Date(created.setup.expires_at).toISOString(),
		);
	});

	it("keeps one unresolved setup per account and provider identity", async () => {
		const created = await context.repository.reservePaymentSetup(voysee, reservation());
		await context.repository.recordPaymentSetupLink(voysee, {
			setupId: created.setup.id,
			externalSessionId: "cs_setup_1",
			sessionUrl: "https://checkout.stripe.test/setup/cs_setup_1",
			externalSetupIntentId: null,
			expiresAt: new Date(Date.now() + 24 * hour),
		});

		const matching = await context.repository.reservePaymentSetup(
			voysee,
			reservation({ previewToken: "22222222-2222-4222-8222-222222222222" }),
		);
		expect(matching).toMatchObject({ kind: "reused" });
		expect(matching.setup.id).toBe(created.setup.id);

		const conflict = await context.repository
			.reservePaymentSetup(
				voysee,
				reservation({
					previewToken: "33333333-3333-4333-8333-333333333333",
					requestHash: "b".repeat(64),
				}),
			)
			.catch((error: unknown) => error);
		if (!isBillingError(conflict)) throw new Error("Expected a billing error");
		expect(conflict.code).toBe("PAYMENT_SETUP_ALREADY_ACTIVE");
		expect(conflict.details).toMatchObject({
			paymentSetup: { setupId: created.setup.id, status: "awaiting_customer" },
		});

		// Another provider identity has a slot of its own.
		const otherAccount = await context.repository.reservePaymentSetup(
			voysee,
			reservation({
				previewToken: "44444444-4444-4444-8444-444444444444",
				providerAccountId: "acct_stripe_2",
			}),
		);
		expect(otherAccount.kind).toBe("created");
	});

	it("frees the slot only once the setup is completed or expired", async () => {
		const created = await context.repository.reservePaymentSetup(voysee, reservation());
		await context.repository.claimPaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
		});
		const flagged = await context.repository.flagPaymentSetupAttention(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
			reason: "The hosted setup link could not be confirmed",
		});
		expect(flagged?.status).toBe("needs_attention");

		// Attention still holds the slot, so the uncertain setup stays visible.
		expect(
			await context.repository.findActivePaymentSetup(voysee, {
				billingAccountId: "setup_account",
				providerAccountId: "acct_stripe_1",
			}),
		).toMatchObject({ id: created.setup.id, status: "needs_attention" });

		await context.repository.claimPaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
		});
		const expired = await context.repository.expirePaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
		});
		expect(expired.status).toBe("expired");
		expect(
			await context.repository.findActivePaymentSetup(voysee, {
				billingAccountId: "setup_account",
				providerAccountId: "acct_stripe_1",
			}),
		).toBeNull();

		const next = await context.repository.reservePaymentSetup(
			voysee,
			reservation({ previewToken: "55555555-5555-4555-8555-555555555555" }),
		);
		expect(next.kind).toBe("created");
		expect(next.setup.id).not.toBe(created.setup.id);
	});

	it("scopes setups to their project", async () => {
		const created = await context.repository.reservePaymentSetup(voysee, reservation());

		// The same account name in another project gets its own slot.
		const other = await context.repository.reservePaymentSetup(wiseley, reservation());
		expect(other.kind).toBe("created");
		expect(other.setup.id).not.toBe(created.setup.id);

		expect(await context.repository.findPaymentSetupById(wiseley, created.setup.id)).toBeNull();
		expect(
			await context.repository.claimPaymentSetup(wiseley, {
				setupId: created.setup.id,
				workerId: "foreign-worker",
			}),
		).toBeNull();
		expect(
			await context.repository.claimPaymentSetup(voysee, {
				setupId: "not-a-uuid",
				workerId: "worker-a",
			}),
		).toBeNull();
		const missing = await context.repository
			.getPaymentSetupSession(wiseley, "setup_account", created.setup.id)
			.catch((error: unknown) => error);
		if (!isBillingError(missing)) throw new Error("Expected a billing error");
		expect(missing.code).toBe("PAYMENT_SETUP_NOT_FOUND");
	});

	it("queues one reconciliation task per setup and brings it forward", async () => {
		const created = await context.repository.reservePaymentSetup(voysee, reservation());
		const later = new Date(Date.now() + 6 * hour);
		const sooner = new Date(Date.now() + 5 * 60_000);
		// Reservation commits its recovery task before any provider call can begin.
		const initial = await context.sql<Array<{ id: string; customer_id: string }>>`
			SELECT id, customer_id FROM store_events
			WHERE project_id = ${voysee.projectInstanceId}
				AND event_type = 'quotum.payment_setup.reconcile'
				AND transaction_id = ${created.setup.id}
		`;
		expect(initial).toHaveLength(1);
		expect(initial[0]?.customer_id).toBe(created.setup.customer_id);

		const first = await context.repository.schedulePaymentSetupReconciliation(voysee, {
			setupId: created.setup.id,
			nextAttemptAt: later,
		});
		const second = await context.repository.schedulePaymentSetupReconciliation(voysee, {
			setupId: created.setup.id,
			nextAttemptAt: sooner,
		});
		expect(second).toBe(first);
		expect(first).toBe(initial[0]?.id);

		const rows = await context.sql<Array<{ event_type: string; next_attempt_at: Date }>>`
			SELECT event_type, next_attempt_at FROM store_events
			WHERE event_type = 'quotum.payment_setup.reconcile'
		`;
		expect(rows).toHaveLength(1);
		expect(new Date(rows[0]?.next_attempt_at ?? 0).getTime()).toBeLessThanOrEqual(
			sooner.getTime() + 1000,
		);
	});

	it("queues a provider event once, however many times it is delivered", async () => {
		const first = await context.repository.enqueueProviderStoreEvent(voysee, {
			provider: "stripe",
			channel: "web",
			externalEventId: "evt_setup_1",
			eventType: "checkout.session.completed",
			transactionId: "cs_setup_1",
			rawPayload: { id: "evt_setup_1", type: "checkout.session.completed", data: { object: {} } },
		});
		const second = await context.repository.enqueueProviderStoreEvent(voysee, {
			provider: "stripe",
			channel: "web",
			externalEventId: "evt_setup_1",
			eventType: "checkout.session.completed",
			transactionId: "cs_setup_1",
			rawPayload: { id: "evt_setup_1", type: "checkout.session.completed", data: { object: {} } },
		});

		expect(first).toMatchObject({ enqueued: true });
		expect(second).toEqual({ storeEventId: first.storeEventId, enqueued: false });
		const rows = await context.sql<Array<{ processing_status: string }>>`
			SELECT processing_status FROM store_events WHERE external_event_id = 'evt_setup_1'
		`;
		expect(rows).toEqual([{ processing_status: "pending" }]);
	});

	it("rolls back a reservation if its durable recovery task cannot be queued", async () => {
		await context.sql`ALTER TABLE store_events ADD CONSTRAINT payment_setup_test_queue_failure CHECK (event_type <> 'quotum.payment_setup.reconcile') NOT VALID`;
		let failure: unknown;
		try {
			await context.repository.reservePaymentSetup(voysee, reservation());
		} catch (error) {
			failure = error;
		} finally {
			await context.sql`ALTER TABLE store_events DROP CONSTRAINT payment_setup_test_queue_failure`;
		}
		// A check violation: the injected constraint, not some earlier failure, stopped it.
		expect(sqlstateOf(failure)).toBe("23514");
		const rows =
			await context.sql`SELECT id FROM payment_setup_sessions WHERE project_id = ${voysee.projectInstanceId}`;
		expect(rows).toHaveLength(0);
	});

	it("preserves the original link and expiry and exposes URLs only while awaiting the customer", async () => {
		const created = await context.repository.reservePaymentSetup(voysee, reservation());
		const link = {
			setupId: created.setup.id,
			externalSessionId: "cs_original",
			sessionUrl: "https://checkout.stripe.test/setup/original",
			externalSetupIntentId: null,
			expiresAt: new Date(Date.now() + 48 * hour),
		};
		const linked = await context.repository.recordPaymentSetupLink(voysee, link);
		expect(new Date(linked.expires_at).toISOString()).toBe(
			new Date(created.setup.expires_at).toISOString(),
		);
		const view = () =>
			context.repository.getPaymentSetupSession(voysee, "setup_account", created.setup.id);
		expect((await view()).url).toBe(link.sessionUrl);
		const repeat = await context.repository.recordPaymentSetupLink(voysee, {
			...link,
			sessionUrl: "https://checkout.stripe.test/setup/replaced",
		});
		expect(repeat.session_url).toBe(link.sessionUrl);
		await expect(
			context.repository.recordPaymentSetupLink(voysee, {
				...link,
				externalSessionId: "cs_different",
			}),
		).rejects.toMatchObject({ code: "PAYMENT_SETUP_SESSION_CONFLICT", status: 409 });
		await context.sql`UPDATE payment_setup_sessions SET expires_at = now() - interval '1 second' WHERE id = ${created.setup.id}`;
		expect((await view()).url).toBeNull();
		await context.sql`UPDATE payment_setup_sessions SET expires_at = ${new Date(created.setup.expires_at).toISOString()} WHERE id = ${created.setup.id}`;
		expect((await view()).url).toBe(link.sessionUrl);
		await context.repository.claimPaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker",
		});
		await context.repository.flagPaymentSetupAttention(voysee, {
			setupId: created.setup.id,
			workerId: "worker",
			reason: "Needs investigation",
		});
		expect((await view()).url).toBeNull();
		await context.repository.claimPaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker",
		});
		await context.repository.recordPaymentSetupIntent(voysee, {
			setupId: created.setup.id,
			workerId: "worker",
			externalSetupIntentId: "seti_original",
			paymentMethodId: "pm_original",
			externalSessionId: link.externalSessionId,
		});
		expect((await view()).url).toBeNull();
		const applied = await context.repository.recordPaymentSetupLink(voysee, link);
		expect(applied.status).toBe("applying_default");
		expect(new Date(applied.expires_at).toISOString()).toBe(
			new Date(created.setup.expires_at).toISOString(),
		);
		expect((await view()).url).toBeNull();
	});

	it("returns existing state for own-preview replays after creation instead of recreating a session", async () => {
		const input = reservation();
		const created = await context.repository.reservePaymentSetup(voysee, input);
		expect((await context.repository.reservePaymentSetup(voysee, input)).kind).toBe("resume");
		await context.repository.recordPaymentSetupLink(voysee, {
			setupId: created.setup.id,
			externalSessionId: "cs_replay",
			sessionUrl: "https://checkout.stripe.test/replay",
			externalSetupIntentId: null,
			expiresAt: input.expiresAt,
		});
		expect((await context.repository.reservePaymentSetup(voysee, input)).kind).toBe("reused");
		await context.sql`UPDATE payment_setup_sessions SET expires_at = now() - interval '1 second' WHERE id = ${created.setup.id}`;
		expect((await context.repository.reservePaymentSetup(voysee, input)).kind).toBe("existing");
		await context.repository.claimPaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker",
		});
		await context.repository.flagPaymentSetupAttention(voysee, {
			setupId: created.setup.id,
			workerId: "worker",
			reason: "Needs investigation",
		});
		expect((await context.repository.reservePaymentSetup(voysee, input)).kind).toBe("existing");
		await context.repository.claimPaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker",
		});
		await context.repository.recordPaymentSetupIntent(voysee, {
			setupId: created.setup.id,
			workerId: "worker",
			externalSetupIntentId: "seti_replay",
			paymentMethodId: "pm_replay",
			externalSessionId: "cs_replay",
		});
		expect((await context.repository.reservePaymentSetup(voysee, input)).kind).toBe("existing");
		await context.repository.completePaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker",
			paymentMethodId: "pm_replay",
			card: null,
		});
		const completed = await context.repository.reservePaymentSetup(voysee, input);
		expect(completed).toMatchObject({
			kind: "existing",
			setup: { id: created.setup.id, status: "completed" },
		});
		const nextInput = reservation({ previewToken: "66666666-6666-4666-8666-666666666666" });
		const next = await context.repository.reservePaymentSetup(voysee, nextInput);
		await context.repository.claimPaymentSetup(voysee, {
			setupId: next.setup.id,
			workerId: "worker",
		});
		await context.repository.expirePaymentSetup(voysee, {
			setupId: next.setup.id,
			workerId: "worker",
		});
		expect(await context.repository.reservePaymentSetup(voysee, nextInput)).toMatchObject({
			kind: "existing",
			setup: { id: next.setup.id, status: "expired" },
		});
	});

	it("links setup events to a persisted customer only within the event's project", async () => {
		const local = await context.repository.reservePaymentSetup(voysee, reservation());
		const foreign = await context.repository.reservePaymentSetup(wiseley, reservation());
		for (const [id, setupId] of [
			["local", local.setup.id],
			["foreign", foreign.setup.id],
			["malformed", "not-a-uuid"],
		]) {
			const queued = await context.repository.enqueueProviderStoreEvent(voysee, {
				provider: "stripe",
				channel: "web",
				externalEventId: `evt_${id}`,
				eventType: "checkout.session.completed",
				transactionId: `cs_${id}`,
				rawPayload: {
					data: {
						object: {
							metadata: { quotumPaymentSetupId: setupId, billingAccountId: "setup_account" },
						},
					},
				},
			});
			const [event] = await context.sql<
				Array<{ customer_id: string | null }>
			>`SELECT customer_id FROM store_events WHERE id = ${queued.storeEventId}`;
			expect(event?.customer_id).toBe(id === "local" ? local.setup.customer_id : null);
		}
	});

	it("stores a plan, records its outcome under the claim, and rejects a partial plan", async () => {
		const created = await context.repository.reservePaymentSetup(
			voysee,
			reservation({
				plan: { planKey: "pro", planVersionId: "42", quantities: { seats: 5 } },
			}),
		);
		expect(created.setup).toMatchObject({
			plan_key: "pro",
			plan_version_id: "42",
			plan_status: "pending",
			plan_quantities: { seats: 5 },
		});
		await context.repository.recordPaymentSetupLink(voysee, {
			setupId: created.setup.id,
			externalSessionId: "cs_plan_1",
			sessionUrl: "https://checkout.stripe.test/setup/cs_plan_1",
			externalSetupIntentId: null,
			expiresAt: new Date(Date.now() + 24 * hour),
		});
		await context.repository.claimPaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
		});
		await context.repository.recordPaymentSetupIntent(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
			externalSetupIntentId: "seti_plan_1",
			paymentMethodId: "pm_plan_1",
			externalSessionId: "cs_plan_1",
		});
		await context.repository.recordPaymentSetupSubscriptionId(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
			externalSubscriptionId: "sub_plan_1",
		});
		const started = await context.repository.recordPaymentSetupPlanOutcome(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
			status: "started",
			externalSubscriptionId: "sub_plan_1",
			failureCode: null,
			failureMessage: null,
		});
		expect(started.plan_status).toBe("started");
		expect(started.plan_resolved_at).not.toBeNull();
		const completed = await context.repository.completePaymentSetup(voysee, {
			setupId: created.setup.id,
			workerId: "worker-a",
			paymentMethodId: "pm_plan_1",
			card: null,
		});
		expect(completed.status).toBe("completed");
		const session = await context.repository.getPaymentSetupSession(
			voysee,
			"setup_account",
			created.setup.id,
		);
		expect(session.plan).toMatchObject({
			planKey: "pro",
			planVersionId: "42",
			status: "started",
			externalSubscriptionId: "sub_plan_1",
			failure: null,
		});

		const partial = await context.repository.reservePaymentSetup(
			wiseley,
			reservation({ previewToken: "33333333-3333-4333-8333-333333333333" }),
		);
		await expectConstraint(
			context.sql`
				UPDATE payment_setup_sessions SET plan_key = 'pro' WHERE id = ${partial.setup.id}::uuid
			`,
			"payment_setup_sessions_plan_presence_check",
		);
		await expectConstraint(
			context.sql`
				UPDATE payment_setup_sessions
				SET plan_key = 'pro', plan_version_id = 7, plan_quantities = '{"seats":1}'::jsonb,
					plan_status = 'started', plan_resolved_at = now()
				WHERE id = ${partial.setup.id}::uuid
			`,
			/payment_setup_sessions_plan_(started|resolved)_check/,
		);
		await expectConstraint(
			context.sql`
				UPDATE payment_setup_sessions
				SET status = 'completed', default_payment_method_id = 'pm_x', completed_at = now(),
					external_session_id = 'cs_partial',
					plan_key = 'pro', plan_version_id = 7, plan_quantities = '{}'::jsonb,
					plan_status = 'pending'
				WHERE id = ${partial.setup.id}::uuid
			`,
			"payment_setup_sessions_plan_pending_completion_check",
		);
	});

	it("mirrors every SQL setup constraint and descending account-history index", async () => {
		const config = getTableConfig(paymentSetupSessions);
		const checks = await context.sql<
			Array<{ conname: string }>
		>`SELECT conname FROM pg_constraint WHERE conrelid = 'payment_setup_sessions'::regclass AND contype = 'c'`;
		expect(config.checks.map((check) => check.name).sort()).toEqual(
			checks.map((check) => check.conname).sort(),
		);
		const index = config.indexes.find(
			(index) => index.config.name === "idx_billing_payment_setup_account_created",
		);
		expect(index?.config.columns[2]).toMatchObject({
			name: "created_at",
			indexConfig: { order: "desc" },
		});
		const [live] = await context.sql<
			Array<{ definition: string }>
		>`SELECT pg_get_indexdef('idx_billing_payment_setup_account_created'::regclass) AS definition`;
		expect(live?.definition).toContain("created_at DESC");
	});
});
