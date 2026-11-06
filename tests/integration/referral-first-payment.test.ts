import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { PromotionEffect, PromotionTarget } from "../../src/billing/promotions";
import type { ReferralRecipient } from "../../src/billing/referrals";
import { ensureCustomer } from "../../src/db/repository/identities";
import { PromotionMaintenanceWorker } from "../../src/workers/promotion-maintenance";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";
import { integrationProjectContextResolver } from "./helpers/platform-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const projectId = project.projectInstanceId;
const actor = "operator@example.com";
const day = 86_400_000;
let context: LocalPostgresContext;

const credits: PromotionEffect = {
	kind: "feature_grant",
	items: [{ featureKey: "ai_credits", quantity: "25", expiresAfterSeconds: null }],
};
const discount: PromotionEffect = {
	kind: "discount",
	discount: { type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
};

function referrals() {
	return context.repository.referrals;
}

async function program(
	options: {
		effect?: PromotionEffect;
		recipient?: ReferralRecipient;
		targets?: PromotionTarget[];
		excludeTrial?: boolean;
	} = {},
): Promise<void> {
	await context.repository.promotions.createPromotion(project, {
		key: "reward",
		name: "Reward",
		effect: options.effect ?? credits,
		actor,
	});
	await referrals().createProgram(project, {
		key: "friends",
		name: "Refer a friend",
		rewardPromotionKey: "reward",
		trigger: "first_payment",
		recipient: options.recipient ?? "referrer",
		targets: options.targets,
		excludeTrial: options.excludeTrial,
		actor,
	});
}

/** The new customer enters the referrer's code. */
async function refer(referee = "bob", referrer = "alice"): Promise<void> {
	await ensureCustomer(context.db as never, projectId, referrer);
	await ensureCustomer(context.db as never, projectId, referee);
	const { code } = await referrals().getOrCreateCode(project, {
		billingAccountId: referrer,
		programKey: "friends",
	});
	await referrals().redeemCode(project, { billingAccountId: referee, code, channel: "web" });
}

/** One pass of the worker's two sweeps; answers how many referrals qualified. */
async function sweep(): Promise<number> {
	const qualified = await referrals().qualifyDueReferrals(100);
	for (const job of await referrals().listDueRewards(100)) {
		await referrals().issueReward(project, job.rewardId);
	}
	return qualified;
}

async function referralStatus(referee = "bob"): Promise<string> {
	const page = await referrals().listAccountReferrals(project, referee, {
		limit: 1,
		cursor: null,
		role: "referee",
	});
	return page.items[0]?.status ?? "none";
}

async function rewardCredits(billingAccountId: string): Promise<number> {
	const [row] = await context.sql<Array<{ total: string | null }>>`
		SELECT sum(allocation.quantity) AS total
		FROM balance_allocations allocation
		JOIN customers customer ON customer.id = allocation.customer_id
		WHERE customer.project_id = ${projectId}
			AND customer.billing_account_id = ${billingAccountId}
			AND allocation.source_kind = 'reward'
	`;
	return Number(row?.total ?? 0);
}

function stripeSubscription(
	billingAccountId: string,
	input: {
		event: string;
		trialDays?: number;
		invoiceId?: string | null;
		amountPaid?: number;
		externalProductId?: string;
		externalPriceId?: string;
	},
) {
	const start = new Date();
	const end = new Date(start.getTime() + 30 * day);
	const trialEnd =
		input.trialDays === undefined ? null : new Date(start.getTime() + input.trialDays * day);
	return context.repository.recordStripeSubscriptionAndEnqueueProjection(project, {
		billingAccountId,
		stripeCustomerId: `cus_${billingAccountId}`,
		stripeSubscriptionId: `sub_${billingAccountId}`,
		invoiceId: input.invoiceId === undefined ? `in_${input.event}` : input.invoiceId,
		externalProductId: input.externalProductId ?? "prod_stripe_premium",
		externalPriceId: input.externalPriceId ?? "price_premium_monthly",
		subscriptionStatus: "active",
		providerStatus: trialEnd === null ? "active" : "trialing",
		purchasedAt: start,
		startsAt: start,
		expiresAt: end,
		currentPeriodStart: start,
		currentPeriodEnd: end,
		trialStart: trialEnd === null ? null : start,
		trialEnd,
		...(input.amountPaid === undefined
			? {}
			: {
					invoiceStatus: "paid",
					invoiceAmountPaid: input.amountPaid,
					invoiceCurrency: "usd",
					invoicePaidAt: start,
				}),
		autoRenew: true,
		rawPayload: {},
		eventType: "invoice.paid",
		externalEventId: `evt_${input.event}`,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `evt_${input.event}:projection`,
		providerEventCreated: Math.floor(start.getTime() / 1000),
	});
}

function stripeCheckout(billingAccountId: string, id: string, amountPaidCents: number) {
	return context.repository.recordStripeCreditPurchaseAndEnqueueProjection(project, {
		purchaseKind: "consumable",
		billingAccountId,
		stripeCustomerId: `cus_${billingAccountId}`,
		externalProductId: "prod_stripe_credits_10",
		externalPriceId: "price_credits_10",
		transactionId: `pi_${id}`,
		paymentIntentId: `pi_${id}`,
		chargeId: `ch_${id}`,
		checkoutSessionId: `cs_${id}`,
		amountPaidCents,
		currency: "usd",
		purchasedAt: new Date(),
		rawPayload: { id: `cs_${id}` },
		eventType: "checkout.session.completed",
		externalEventId: `evt_${id}`,
		projectionIdempotencyKey: `stripe:payment:pi_${id}:projection`,
	});
}

function apple(
	billingAccountId: string,
	transaction: string,
	input: { purchasedAt: Date; expiresAt: Date; trial?: boolean },
) {
	return context.repository.recordStoreKitTransactionAndEnqueueProjection(project, {
		billingAccountId,
		appAccountToken: null,
		channel: "ios",
		externalProductId: "premium_monthly",
		purchaseKind: "subscription",
		transactionId: transaction,
		originalTransactionId: `${billingAccountId}_original`,
		webOrderLineItemId: `${transaction}_line`,
		purchaseStatus: "completed",
		subscriptionStatus: "active",
		purchasedAt: input.purchasedAt,
		expiresAt: input.expiresAt,
		trialStart: input.trial === true ? input.purchasedAt : null,
		trialEnd: input.trial === true ? input.expiresAt : null,
		autoRenew: true,
		invalidatedAt: null,
		invalidationReason: null,
		rawPayload: { fixture: transaction },
		eventType: "SUBSCRIBED",
		externalEventId: `${transaction}_event`,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `${transaction}:projection`,
	});
}

function google(
	billingAccountId: string,
	input: { eventType: string; eventId: string; start: Date; expiresAt: Date; trial?: boolean },
) {
	return context.repository.recordGooglePurchaseAndEnqueueProjection(project, {
		billingAccountId,
		obfuscatedAccountId: null,
		externalProductId: "premium_monthly",
		externalPriceId: "monthly-base",
		purchaseKind: "subscription",
		purchaseToken: `${billingAccountId}_token`,
		linkedPurchaseToken: null,
		orderId: `GPA.${input.eventId}`,
		purchaseStatus: "completed",
		subscriptionStatus: "active",
		// Play's startTime: every renewal of one token reports the same start.
		purchasedAt: input.start,
		expiresAt: input.expiresAt,
		trialStart: input.trial === true ? input.start : null,
		trialEnd: input.trial === true ? input.expiresAt : null,
		autoRenew: true,
		acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
		consumptionState: null,
		quantity: 1,
		refundableQuantity: null,
		invalidatedAt: null,
		invalidationReason: null,
		rawPayload: { fixture: input.eventId },
		eventType: input.eventType,
		externalEventId: input.eventId,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `${input.eventId}:projection`,
	});
}

async function refusal(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
	} catch (error) {
		return (error as { code: string }).code;
	}
	throw new Error("the call was not refused");
}

localDescribe("Referrals earned by a first payment", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	describe("before the payment", () => {
		it("records the referral and rewards nobody", async () => {
			await program({ recipient: "both" });

			await refer();

			expect(await referralStatus()).toBe("pending");
			expect(await sweep()).toBe(0);
			expect(await referralStatus()).toBe("pending");
			expect(await rewardCredits("alice")).toBe(0);
			expect(await rewardCredits("bob")).toBe(0);
		});

		it("gives a referee's discount at once, and the referrer's only after the payment", async () => {
			await program({ effect: discount, recipient: "both" });

			await refer();

			const reward = async (account: string, role: "referrer" | "referee") =>
				(
					await referrals().listAccountReferrals(project, account, {
						limit: 1,
						cursor: null,
						role,
					})
				).items[0]?.rewards[0];
			expect(await reward("bob", "referee")).toMatchObject({ status: "held" });
			expect(await reward("alice", "referrer")).toBeUndefined();

			await stripeSubscription("bob", { event: "paid", amountPaid: 1000 });
			expect(await sweep()).toBe(1);

			expect(await reward("alice", "referrer")).toMatchObject({ status: "held" });
			const [counts] = await context.sql`SELECT count(*)::int AS count FROM referral_rewards`;
			expect(counts.count).toBe(2);
		});
	});

	describe("Stripe", () => {
		it("qualifies on a paid subscription invoice, once however often events repeat", async () => {
			await program({ recipient: "both" });
			await refer();

			await stripeSubscription("bob", { event: "paid", amountPaid: 1000 });
			await stripeSubscription("bob", { event: "paid", amountPaid: 1000 });

			expect(await sweep()).toBe(1);
			expect(await referralStatus()).toBe("qualified");
			expect(await rewardCredits("alice")).toBe(25);
			expect(await rewardCredits("bob")).toBe(25);

			await stripeSubscription("bob", { event: "renewal", amountPaid: 1000 });

			expect(await sweep()).toBe(0);
			expect(await rewardCredits("alice")).toBe(25);
		});

		it("does not count a trial or a free invoice, and counts the first real payment", async () => {
			await program();
			await refer();

			await stripeSubscription("bob", { event: "trial", trialDays: 7, amountPaid: 0 });
			expect(await sweep()).toBe(0);
			expect(await referralStatus()).toBe("pending");

			await stripeSubscription("bob", { event: "converted", amountPaid: 1000 });
			expect(await sweep()).toBe(1);
			expect(await rewardCredits("alice")).toBe(25);
		});

		it("counts a trial starting when the program says so", async () => {
			await program({ excludeTrial: false });
			await refer();

			await stripeSubscription("bob", { event: "trial", trialDays: 7, invoiceId: null });

			expect(await sweep()).toBe(1);
		});

		it("counts a trial that was already running when the code was entered", async () => {
			await program({ excludeTrial: false });
			await ensureCustomer(context.db as never, projectId, "bob");
			await stripeSubscription("bob", { event: "trial", trialDays: 7, invoiceId: null });

			await refer();

			expect(await referralStatus()).toBe("pending");
			expect(await sweep()).toBe(1);
		});

		it("qualifies on a one-time checkout", async () => {
			await program();
			await refer();

			await stripeCheckout("bob", "one", 1500);

			expect(await sweep()).toBe(1);
		});

		it("does not count a free checkout, or one refunded before the sweep ran", async () => {
			await program();
			await refer();

			await stripeCheckout("bob", "free", 0);
			expect(await sweep()).toBe(0);

			await stripeCheckout("bob", "paid", 1500);
			await context.repository.recordStripeCreditReversalAndEnqueueProjection(project, {
				reversalReason: "refund",
				reversalId: "re_paid",
				reversalAmount: 1500,
				reversalCurrency: "usd",
				paymentIntentId: "pi_paid",
				chargeId: "ch_paid",
				reversedAt: new Date(),
				rawPayload: { id: "re_paid" },
				eventType: "refund.created",
				externalEventId: "evt_paid_refund",
				projectionIdempotencyKey: "stripe:refund:re_paid:projection",
			});

			expect(await sweep()).toBe(0);
			expect(await referralStatus()).toBe("pending");
		});
	});

	describe("the App Store", () => {
		it("does not count a free trial, and counts the first renewal after it", async () => {
			await program();
			await refer();
			const start = new Date();
			const trialEnd = new Date(start.getTime() + 7 * day);

			await apple("bob", "1000", { purchasedAt: start, expiresAt: trialEnd, trial: true });
			expect(await sweep()).toBe(0);

			await apple("bob", "1001", {
				purchasedAt: trialEnd,
				expiresAt: new Date(trialEnd.getTime() + 30 * day),
			});
			expect(await sweep()).toBe(1);
		});

		it("qualifies on a purchase with no trial", async () => {
			await program();
			await refer();
			const start = new Date();

			await apple("bob", "2000", {
				purchasedAt: start,
				expiresAt: new Date(start.getTime() + 30 * day),
			});

			expect(await sweep()).toBe(1);
		});
	});

	describe("Google Play", () => {
		it("does not count a free trial, and counts its conversion", async () => {
			await program();
			await refer();
			const start = new Date();
			const trialEnd = new Date(start.getTime() + 7 * day);

			await google("bob", {
				eventType: "purchase_verified",
				eventId: "trial",
				start,
				expiresAt: trialEnd,
				trial: true,
			});
			expect(await sweep()).toBe(0);

			await google("bob", {
				eventType: "SUBSCRIPTION_RENEWED",
				eventId: "renewal",
				start,
				expiresAt: new Date(trialEnd.getTime() + 30 * day),
			});
			expect(await sweep()).toBe(1);
		});

		it("qualifies on a purchase with no trial", async () => {
			await program();
			await refer();
			const start = new Date();

			await google("bob", {
				eventType: "purchase_verified",
				eventId: "paid",
				start,
				expiresAt: new Date(start.getTime() + 30 * day),
			});

			expect(await sweep()).toBe(1);
		});
	});

	describe("targets", () => {
		it("counts only a payment for a targeted plan", async () => {
			await program({ targets: [{ kind: "plan", key: "premium" }] });
			await refer();

			await stripeCheckout("bob", "credits", 1500);
			expect(await sweep()).toBe(0);

			await stripeSubscription("bob", { event: "paid", amountPaid: 1000 });
			expect(await sweep()).toBe(1);
		});

		it("counts only a payment for a targeted product", async () => {
			await program({ targets: [{ kind: "product", key: "echo_credits_10" }] });
			await refer();

			await stripeSubscription("bob", { event: "paid", amountPaid: 1000 });
			expect(await sweep()).toBe(0);

			await stripeCheckout("bob", "credits", 1500);
			expect(await sweep()).toBe(1);
		});

		it("applies to a store purchase too", async () => {
			await program({ targets: [{ kind: "plan", key: "premium" }] });
			await refer();
			const start = new Date();

			await apple("bob", "3000", {
				purchasedAt: start,
				expiresAt: new Date(start.getTime() + 30 * day),
			});

			expect(await sweep()).toBe(1);
		});
	});

	describe("a payment arriving during the check", () => {
		async function due(): Promise<number> {
			const [row] = await context.sql`
				SELECT count(*)::int AS count FROM referrals WHERE check_due_at IS NOT NULL
			`;
			return row.count;
		}

		async function insertPaidInvoice(tx: typeof context.sql, customerId: string) {
			await tx`
				INSERT INTO billing_invoices (
					project_id, customer_id, external_invoice_id, external_subscription_id, status,
					amount_paid, currency, paid_at, provider_created_at
				) VALUES (
					${projectId}, ${customerId}, 'in_race', 'sub_race', 'paid', 1000, 'usd',
					${new Date().toISOString()}, ${new Date().toISOString()}
				)
			`;
		}

		async function bob(): Promise<string> {
			const [row] = await context.sql`
				SELECT id FROM customers WHERE project_id = ${projectId} AND billing_account_id = 'bob'
			`;
			return row.id;
		}

		it("waits for a payment that already holds the referee's lock", async () => {
			await program();
			await refer();
			const customerId = await bob();
			let checked: Promise<number> | undefined;

			await context.sql.begin(async (tx) => {
				await tx`SELECT id FROM customers WHERE id = ${customerId} FOR NO KEY UPDATE`;
				await insertPaidInvoice(tx as never, customerId);
				checked = referrals().qualifyDueReferrals(10);
				await Bun.sleep(150);
			});

			expect(await checked).toBe(1);
			expect(await due()).toBe(0);
		});

		it("is told again by a payment that commits after the check read nothing", async () => {
			await program();
			await refer();
			const customerId = await bob();

			await context.sql.begin(async (tx) => {
				await insertPaidInvoice(tx as never, customerId);
				// The check runs first and cannot see the uncommitted invoice.
				expect(await referrals().qualifyDueReferrals(10)).toBe(0);
				expect(await due()).toBe(0);
				// What enqueueProjectionSyncJob does in the payment's own transaction.
				await tx`
					UPDATE referrals SET check_due_at = now()
					WHERE project_id = ${projectId} AND customer_id = ${customerId}
						AND status = 'pending' AND check_due_at IS NULL
				`;
			});

			expect(await due()).toBe(1);
			expect(await sweep()).toBe(1);
		});
	});

	describe("programs", () => {
		it("refuses terms the trigger cannot use, and a target that does not exist", async () => {
			await context.repository.promotions.createPromotion(project, {
				key: "reward",
				name: "Reward",
				effect: credits,
				actor,
			});
			const input = {
				key: "friends",
				name: "Friends",
				rewardPromotionKey: "reward",
				recipient: "referrer" as const,
				actor,
			};

			expect(
				await refusal(() =>
					referrals().createProgram(project, {
						...input,
						trigger: "redemption",
						targets: [{ kind: "plan", key: "premium" }],
					}),
				),
			).toBe("REFERRAL_PROGRAM_INVALID");
			expect(
				await refusal(() =>
					referrals().createProgram(project, {
						...input,
						trigger: "redemption",
						excludeTrial: false,
					}),
				),
			).toBe("REFERRAL_PROGRAM_INVALID");
			expect(
				await refusal(() =>
					referrals().createProgram(project, {
						...input,
						trigger: "first_payment",
						targets: [{ kind: "plan", key: "missing" }],
					}),
				),
			).toBe("REFERRAL_PROGRAM_INVALID");
		});

		it("treats targets in another order as the same terms", async () => {
			await context.repository.promotions.createPromotion(project, {
				key: "reward",
				name: "Reward",
				effect: credits,
				actor,
			});
			const input = {
				key: "friends",
				name: "Friends",
				rewardPromotionKey: "reward",
				trigger: "first_payment" as const,
				recipient: "referrer" as const,
				actor,
			};
			const plan: PromotionTarget = { kind: "plan", key: "premium" };
			const product: PromotionTarget = { kind: "product", key: "echo_credits_10" };

			const first = await referrals().createProgram(project, {
				...input,
				targets: [plan, product],
			});
			const second = await referrals().createProgram(project, {
				...input,
				targets: [product, plan],
			});

			expect(first.created).toBe(true);
			expect(second.created).toBe(false);
			expect(first.program.targets).toEqual([plan, product]);
			expect(first.program.excludeTrial).toBe(true);
		});
	});

	it("still rewards a referral from an archived program", async () => {
		await program();
		await refer();
		await referrals().archiveProgram(project, "friends", actor);

		await stripeSubscription("bob", { event: "paid", amountPaid: 1000 });

		expect(await sweep()).toBe(1);
		expect(await rewardCredits("alice")).toBe(25);
	});

	it("does not qualify a referee erased in the meantime", async () => {
		await program();
		await refer();
		await stripeSubscription("bob", { event: "paid", amountPaid: 1000 });
		await context.sql`
			UPDATE customers SET erased_at = now()
			WHERE project_id = ${projectId} AND billing_account_id = 'bob'
		`;

		expect(await sweep()).toBe(0);
		const [row] = await context.sql`SELECT status, check_due_at FROM referrals`;
		expect(row).toEqual({ status: "pending", check_due_at: null });
	});
});

localDescribe("Referral discounts on a live subscription", () => {
	const percent: PromotionEffect = {
		kind: "discount",
		discount: { type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
	};
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	/** What Stripe holds, and every write the worker made to it. */
	function stripe(options: { failNext?: () => Error | null } = {}) {
		const attached = new Map<string, string[]>();
		const calls: Array<{ externalSubscriptionId: string; idempotencyKey: string; retry: boolean }> =
			[];
		const addSubscriptionDiscount = async (input: {
			promotionId: string;
			externalSubscriptionId: string;
			idempotencyKey: string;
			retry: boolean;
		}) => {
			calls.push(input);
			const existing = attached.get(input.externalSubscriptionId) ?? [];
			if (existing.length > 0) {
				return input.retry && existing.includes(input.promotionId)
					? ("added" as const)
					: ("already_discounted" as const);
			}
			attached.set(input.externalSubscriptionId, [input.promotionId]);
			const failure = options.failNext?.();
			if (failure) throw failure;
			return "added" as const;
		};
		return { attached, calls, addSubscriptionDiscount };
	}

	function worker(fake: ReturnType<typeof stripe> | null) {
		return new PromotionMaintenanceWorker({
			workerId: "referral-worker",
			referralRewards: context.repository.referrals,
			repository: {
				releaseExpiredPromotionReservations: (limit) =>
					context.repository.promotions.releaseExpiredPromotionReservations(limit),
				reconcilePromotionCoupons: async () => ({ couponsCreated: 0 }),
				ensureHostedPromotionCodeObjects: async () => 0,
				renewStripeObjectLease: async () => true,
				claimStripeObjects: async () => [],
				markStripeObjectOutcome: async () => {},
			},
			projectContextResolver: integrationProjectContextResolver(),
			adapterForJob: () =>
				fake === null
					? null
					: {
							promotions: {
								syncObject: async () => ({ kind: "failed", error: "unused", terminal: true }),
								addSubscriptionDiscount: fake.addSubscriptionDiscount,
							},
						},
			logger: { error() {} },
		});
	}

	async function rewardRow(recipient: "referrer" | "referee" = "referrer") {
		const [row] = await context.sql`
			SELECT status, reason, attempts FROM referral_rewards WHERE recipient = ${recipient}
		`;
		return row;
	}

	/** A paying referrer whose friend's payment earned a discount. */
	async function earnDiscount(referrer = "alice", referee = "bob"): Promise<void> {
		await ensureCustomer(context.db as never, projectId, referrer);
		await stripeSubscription(referrer, { event: `${referrer}-paid`, amountPaid: 1000 });
		await ensureCustomer(context.db as never, projectId, referee);
		const { code } = await referrals().getOrCreateCode(project, {
			billingAccountId: referrer,
			programKey: "friends",
		});
		await referrals().redeemCode(project, { billingAccountId: referee, code, channel: "web" });
		await stripeSubscription(referee, { event: `${referee}-paid`, amountPaid: 1000 });
	}

	it("puts the discount on the referrer's subscription and issues the reward", async () => {
		await program({ effect: percent });
		await earnDiscount();
		const fake = stripe();

		const result = await worker(fake).runOnce();

		expect(result).toMatchObject({ referralsQualified: 1, referralDiscountsApplied: 1 });
		expect(fake.calls).toEqual([
			expect.objectContaining({ externalSubscriptionId: "sub_alice", retry: false }),
		]);
		expect(await rewardRow()).toMatchObject({ status: "issued", reason: null });
		const [redemption] = await context.sql`
			SELECT status, provider, source, external_subscription_id FROM promotion_redemptions
		`;
		expect(redemption).toEqual({
			status: "applied",
			provider: "stripe",
			source: "commercial_action",
			external_subscription_id: "sub_alice",
		});

		const again = await worker(fake).runOnce();

		expect(again.referralDiscountsApplied).toBe(0);
		expect(fake.calls).toHaveLength(1);
	});

	it("keeps the code for a referrer with no subscription, and applies it once there is one", async () => {
		await program({ effect: percent });
		await ensureCustomer(context.db as never, projectId, "alice");
		await refer();
		await stripeSubscription("bob", { event: "bob-paid", amountPaid: 1000 });
		const fake = stripe();

		expect((await worker(fake).runOnce()).referralDiscountsApplied).toBe(0);
		expect(await rewardRow()).toMatchObject({ status: "held", reason: "DISCOUNT_CODE" });

		await stripeSubscription("alice", { event: "alice-paid", amountPaid: 1000 });

		expect((await worker(fake).runOnce()).referralDiscountsApplied).toBe(1);
		expect(await rewardRow()).toMatchObject({ status: "issued" });
	});

	it("waits while the subscription already has a discount, and gives the code back", async () => {
		await program({ effect: percent });
		await earnDiscount();
		const fake = stripe();
		fake.attached.set("sub_alice", ["a-merchant-coupon"]);

		expect((await worker(fake).runOnce()).referralDiscountsApplied).toBe(0);

		expect(await rewardRow()).toMatchObject({
			status: "held",
			reason: "SUBSCRIPTION_HAS_DISCOUNT",
		});
		const [redemption] = await context.sql`SELECT status FROM promotion_redemptions`;
		expect(redemption?.status).toBe("released");
		const [code] = await context.sql`
			SELECT redeemed_count, reserved_count FROM promotion_codes
			WHERE created_by = 'system:referral'
		`;
		expect(code).toEqual({ redeemed_count: 0, reserved_count: 0 });

		// A day later the discount is gone, so the same reward goes on after all.
		fake.attached.clear();
		await context.sql`UPDATE referral_rewards SET next_attempt_at = now()`;

		expect((await worker(fake).runOnce()).referralDiscountsApplied).toBe(1);
		expect(await rewardRow()).toMatchObject({ status: "issued" });
	});

	it("does not spend a second reward on a coupon a first one already attached", async () => {
		await program({ effect: percent, recipient: "referrer" });
		await earnDiscount("alice", "bob");
		const fake = stripe();
		await worker(fake).runOnce();
		await ensureCustomer(context.db as never, projectId, "carol");
		const { code } = await referrals().getOrCreateCode(project, {
			billingAccountId: "alice",
			programKey: "friends",
		});
		await referrals().redeemCode(project, { billingAccountId: "carol", code, channel: "web" });
		await stripeSubscription("carol", { event: "carol-paid", amountPaid: 1000 });

		const result = await worker(fake).runOnce();

		expect(result.referralDiscountsApplied).toBe(0);
		const rows = await context.sql`
			SELECT status, reason FROM referral_rewards ORDER BY id
		`;
		expect(rows).toEqual([
			{ status: "issued", reason: null },
			{ status: "held", reason: "SUBSCRIPTION_HAS_DISCOUNT" },
		]);
	});

	it("finishes after losing Stripe's response, without a second write", async () => {
		await program({ effect: percent });
		await earnDiscount();
		let lost = true;
		const fake = stripe({
			failNext: () => {
				if (!lost) return null;
				lost = false;
				return new Error("socket hang up");
			},
		});

		const first = await worker(fake).runOnce();

		expect(first.referralDiscountsApplied).toBe(0);
		expect(await rewardRow()).toMatchObject({ status: "held", attempts: 1 });
		await context.sql`UPDATE referral_rewards SET next_attempt_at = now()`;

		const second = await worker(fake).runOnce();

		expect(second.referralDiscountsApplied).toBe(1);
		expect(fake.calls.map((call) => call.retry)).toEqual([false, true]);
		expect(new Set(fake.calls.map((call) => call.idempotencyKey)).size).toBe(1);
		expect(await rewardRow()).toMatchObject({ status: "issued" });
	});

	it("stops trying after the attempt budget and leaves the code usable", async () => {
		await program({ effect: percent });
		await earnDiscount();
		const fake = stripe({ failNext: () => new Error("always down") });
		fake.attached.clear();
		const down = new PromotionMaintenanceWorker({
			workerId: "referral-worker",
			maxAttempts: 2,
			referralRewards: context.repository.referrals,
			repository: {
				releaseExpiredPromotionReservations: async () => 0,
				reconcilePromotionCoupons: async () => ({ couponsCreated: 0 }),
				ensureHostedPromotionCodeObjects: async () => 0,
				renewStripeObjectLease: async () => true,
				claimStripeObjects: async () => [],
				markStripeObjectOutcome: async () => {},
			},
			projectContextResolver: integrationProjectContextResolver(),
			adapterForJob: () => ({
				promotions: {
					syncObject: async () => ({ kind: "failed", error: "unused", terminal: true }),
					addSubscriptionDiscount: async () => {
						throw new Error("always down");
					},
				},
			}),
			logger: { error() {} },
		});

		await down.runOnce();
		await context.sql`UPDATE referral_rewards SET next_attempt_at = now()`;
		await down.runOnce();
		await context.sql`UPDATE referral_rewards SET next_attempt_at = now()`;

		expect(await referrals().listHeldDiscounts(10, 2)).toEqual([]);
		expect(await rewardRow()).toMatchObject({
			status: "held",
			reason: "DISCOUNT_CODE",
			attempts: 2,
		});
	});

	it("waits for a pending plan change, which rewrites the same discount list", async () => {
		await program({ effect: percent });
		await earnDiscount();
		await context.sql`
			INSERT INTO subscription_changes (
				project_id, customer_id, subscription_id, provider, from_plan_version_id,
				to_plan_version_id, change_kind, effective_mode, effective_at, proration_behavior,
				idempotency_key, request_hash
			)
			SELECT subscription.project_id, subscription.customer_id, subscription.id, 'stripe',
				subscription.plan_version_id, subscription.plan_version_id, 'quantity', 'immediate', now(),
				'none', 'change-1', ${"d".repeat(64)}
			FROM subscriptions subscription
			WHERE subscription.external_subscription_id = 'sub_alice'
		`;
		const fake = stripe();

		await worker(fake).runOnce();

		expect(fake.calls).toEqual([]);
		expect(await rewardRow()).toMatchObject({
			status: "held",
			reason: "SUBSCRIPTION_CHANGE_PENDING",
		});
	});

	it("leaves a discount restricted to another plan as a code, and burns nothing", async () => {
		await context.repository.promotions.createPromotion(project, {
			key: "other-plan",
			name: "Other plan",
			effect: percent,
			targets: [{ kind: "product", key: "echo_credits_10" }],
			actor,
		});
		await referrals().createProgram(project, {
			key: "friends",
			name: "Friends",
			rewardPromotionKey: "other-plan",
			trigger: "first_payment",
			recipient: "referrer",
			actor,
		});
		await earnDiscount();
		const fake = stripe();

		await worker(fake).runOnce();

		expect(fake.calls).toEqual([]);
		expect(await rewardRow()).toMatchObject({
			status: "held",
			reason: "PROMOTION_CODE_NOT_APPLICABLE",
		});
		const [count] = await context.sql`SELECT count(*)::int AS count FROM promotion_redemptions`;
		expect(count.count).toBe(0);
	});

	it("skips a subscription set to cancel, which has no next invoice", async () => {
		await program({ effect: percent });
		await earnDiscount();
		await context.sql`
			UPDATE subscriptions SET cancel_at_period_end = true
			WHERE external_subscription_id = 'sub_alice'
		`;
		const fake = stripe();

		await worker(fake).runOnce();

		expect(fake.calls).toEqual([]);
		expect(await rewardRow()).toMatchObject({ status: "held", reason: "DISCOUNT_CODE" });
	});

	it("waits for Stripe when the environment has no connection", async () => {
		await program({ effect: percent });
		await earnDiscount();

		await worker(null).runOnce();

		expect(await rewardRow()).toMatchObject({ status: "held", reason: "STRIPE_NOT_CONFIGURED" });
		const [redemption] = await context.sql`SELECT status FROM promotion_redemptions`;
		expect(redemption?.status).toBe("released");
	});

	it("keeps a recipient's own code usable at checkout while it waits", async () => {
		await program({ effect: percent });
		await ensureCustomer(context.db as never, projectId, "alice");
		await refer();
		await stripeSubscription("bob", { event: "bob-paid", amountPaid: 1000 });
		await worker(stripe()).runOnce();

		const [reward] =
			(
				await referrals().listAccountReferrals(project, "alice", {
					limit: 1,
					cursor: null,
					role: "referrer",
				})
			).items[0]?.rewards ?? [];

		expect(reward).toMatchObject({ status: "held", effectKind: "discount" });
		expect(reward?.code).not.toBeNull();
	});
});
