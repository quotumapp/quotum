import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { PromotionEffect } from "../../src/billing/promotions";
import type { ReferralRecipient } from "../../src/billing/referrals";
import type { AuthoredCatalogIntent } from "../../src/catalog/types";
import { ensureCustomer } from "../../src/db/repository/identities";
import { ReferralRepository } from "../../src/db/repository/referrals";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { recordedEvents, subscribeToEveryEvent } from "./helpers/domain-event-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { aiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const projectId = project.projectInstanceId;
const actor = "operator@example.com";
let context: LocalPostgresContext;

const credits: PromotionEffect = {
	kind: "feature_grant",
	items: [{ featureKey: "ai_credits", quantity: "25", expiresAfterSeconds: null }],
};
const discount: PromotionEffect = {
	kind: "discount",
	discount: { type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
};
const premiumMonth: PromotionEffect = {
	kind: "plan_grant",
	planKey: "premium",
	durationUnit: "month",
	durationCount: 1,
};

const catalog: AuthoredCatalogIntent = aiCreditsCatalog;

function referrals() {
	return context.repository.referrals;
}

async function publishCatalog(): Promise<void> {
	const preview = await context.repository.previewCatalog(project, {
		expectedRevision: null,
		actor,
		catalog,
	});
	await context.repository.publishCatalog(project, {
		expectedRevision: null,
		actor,
		previewToken: preview.previewToken,
		catalog,
	});
}

async function accounts(...ids: string[]): Promise<void> {
	for (const id of ids) await ensureCustomer(context.db as never, projectId, id);
}

async function program(
	effect: PromotionEffect,
	options: { recipient?: ReferralRecipient; cap?: number; channels?: Array<"web" | "ios"> } = {},
): Promise<string> {
	await context.repository.promotions.createPromotion(project, {
		key: "reward",
		name: "Reward",
		effect,
		allowedChannels: options.channels,
		actor,
	});
	await referrals().createProgram(project, {
		key: "friends",
		name: "Refer a friend",
		rewardPromotionKey: "reward",
		trigger: "redemption",
		recipient: options.recipient ?? "referrer",
		maxRewardsPerReferrer: options.cap ?? null,
		actor,
	});
	return "friends";
}

async function codeOf(billingAccountId: string, programKey = "friends"): Promise<string> {
	return (await referrals().getOrCreateCode(project, { billingAccountId, programKey })).code;
}

function redeem(billingAccountId: string, code: string, channel: "web" | "ios" = "web") {
	return referrals().redeemCode(project, { billingAccountId, code, channel });
}

async function rewardCredits(billingAccountId: string): Promise<number> {
	const [row] = await context.sql<Array<{ total: string | null }>>`
		SELECT sum(allocation.quantity) AS total
		FROM balance_allocations allocation
		JOIN customers customer ON customer.id = allocation.customer_id
		WHERE customer.project_id = ${projectId}
			AND customer.billing_account_id = ${billingAccountId}
			AND allocation.source_kind = 'reward'
			AND allocation.reversed_at IS NULL
	`;
	return Number(row?.total ?? 0);
}

async function paySubscription(billingAccountId: string): Promise<void> {
	const start = new Date();
	const end = new Date(start.getTime() + 30 * 86_400_000);
	await context.repository.recordStripeSubscriptionAndEnqueueProjection(project, {
		billingAccountId,
		stripeCustomerId: `cus_${billingAccountId}`,
		stripeSubscriptionId: `sub_${billingAccountId}`,
		invoiceId: `in_${billingAccountId}`,
		externalProductId: "prod_stripe_premium",
		externalPriceId: "price_premium_monthly",
		subscriptionStatus: "active",
		purchasedAt: start,
		startsAt: start,
		expiresAt: end,
		currentPeriodStart: start,
		currentPeriodEnd: end,
		invoiceStatus: "paid",
		invoiceAmountPaid: 1000,
		invoiceCurrency: "usd",
		invoicePaidAt: start,
		autoRenew: true,
		rawPayload: {},
		eventType: "invoice.paid",
		externalEventId: `evt_${billingAccountId}`,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `evt_${billingAccountId}:projection`,
		providerEventCreated: 1,
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

localDescribe("Referral programs", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishCatalog();
	});
	afterAll(async () => {
		await context.sql.close();
	});

	describe("programs", () => {
		it("creates once, replays the same terms and refuses different ones", async () => {
			await context.repository.promotions.createPromotion(project, {
				key: "reward",
				name: "Reward",
				effect: credits,
				actor,
			});
			const input = {
				key: "friends",
				name: "Refer a friend",
				rewardPromotionKey: "reward",
				trigger: "redemption" as const,
				recipient: "both" as const,
				maxRewardsPerReferrer: 5,
				actor,
			};

			const first = await referrals().createProgram(project, input);
			const replay = await referrals().createProgram(project, input);

			expect(first.created).toBe(true);
			expect(first.program).toMatchObject({
				key: "friends",
				status: "active",
				rewardPromotionKey: "reward",
				recipient: "both",
				maxRewardsPerReferrer: 5,
				createdBy: actor,
			});
			expect(replay).toEqual({ program: first.program, created: false });
			expect(
				await refusal(() =>
					referrals().createProgram(project, { ...input, recipient: "referrer" }),
				),
			).toBe("REFERRAL_PROGRAM_KEY_CONFLICT");
		});

		it("refuses a reward it could not deliver", async () => {
			await context.repository.promotions.createPromotion(project, {
				key: "ios-only",
				name: "iOS only",
				effect: discount,
				allowedChannels: ["ios"],
				actor,
			});
			const input = {
				key: "friends",
				name: "Friends",
				trigger: "redemption" as const,
				recipient: "referrer" as const,
				actor,
			};

			expect(
				await refusal(() =>
					referrals().createProgram(project, { ...input, rewardPromotionKey: "ios-only" }),
				),
			).toBe("REFERRAL_PROGRAM_INVALID");
			expect(
				await refusal(() =>
					referrals().createProgram(project, { ...input, rewardPromotionKey: "missing" }),
				),
			).toBe("PROMOTION_NOT_FOUND");
		});

		it("lists, pages and archives", async () => {
			await context.repository.promotions.createPromotion(project, {
				key: "reward",
				name: "Reward",
				effect: credits,
				actor,
			});
			for (const key of ["one", "two", "three"]) {
				await referrals().createProgram(project, {
					key,
					name: key,
					rewardPromotionKey: "reward",
					trigger: "redemption",
					recipient: "referrer",
					actor,
				});
			}

			const first = await referrals().listPrograms(project, {
				limit: 2,
				cursor: null,
				status: null,
			});
			const rest = await referrals().listPrograms(project, {
				limit: 2,
				cursor: first.nextCursor,
				status: null,
			});
			expect(first.items.map((item) => item.key)).toEqual(["three", "two"]);
			expect(rest.items.map((item) => item.key)).toEqual(["one"]);
			expect(rest.nextCursor).toBeNull();

			const archived = await referrals().archiveProgram(project, "two", actor);
			expect(archived).toMatchObject({ status: "archived", archivedBy: actor });
			expect(
				(
					await referrals().listPrograms(project, { limit: 10, cursor: null, status: "active" })
				).items.map((item) => item.key),
			).toEqual(["three", "one"]);
			expect(await refusal(() => referrals().getProgram(project, "missing"))).toBe(
				"REFERRAL_PROGRAM_NOT_FOUND",
			);
		});

		it("keeps a promotion from being archived under an active program", async () => {
			await program(credits);

			expect(
				await refusal(() =>
					context.repository.promotions.archivePromotion(project, "reward", actor),
				),
			).toBe("PROMOTION_HAS_ACTIVE_REFERRAL_PROGRAM");

			await referrals().archiveProgram(project, "friends", actor);
			const archived = await context.repository.promotions.archivePromotion(
				project,
				"reward",
				actor,
			);
			expect(archived.status).toBe("archived");
		});
	});

	describe("codes", () => {
		it("gives one account one stable code per program", async () => {
			await program(credits);
			await accounts("alice");

			const first = await referrals().getOrCreateCode(project, {
				billingAccountId: "alice",
				programKey: "friends",
			});
			const second = await referrals().getOrCreateCode(project, {
				billingAccountId: "alice",
				programKey: "friends",
			});

			expect(first.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
			expect(second).toEqual(first);
		});

		it("needs an existing account and an active program for a new code", async () => {
			await program(credits);
			await accounts("alice", "bob");
			const code = await codeOf("alice");
			expect(await refusal(() => codeOf("stranger"))).toBe("BILLING_ACCOUNT_NOT_FOUND");
			expect(await refusal(() => codeOf("alice", "missing"))).toBe("REFERRAL_PROGRAM_NOT_FOUND");

			await referrals().archiveProgram(project, "friends", actor);

			expect(await codeOf("alice")).toBe(code);
			expect(await refusal(() => codeOf("bob"))).toBe("REFERRAL_PROGRAM_ARCHIVED");
		});
	});

	describe("redemption", () => {
		it("rewards the referrer through the redemption ledger and records who referred whom", async () => {
			await program(credits);
			await accounts("alice", "bob");

			const result = await redeem("bob", await codeOf("alice"));

			expect(result.duplicate).toBe(false);
			expect(result.referral).toMatchObject({
				programKey: "friends",
				role: "referee",
				counterpartBillingAccountId: "alice",
				status: "qualified",
				rewards: [],
			});
			expect(await rewardCredits("alice")).toBe(25);
			expect(await rewardCredits("bob")).toBe(0);

			const [mine] = (
				await referrals().listAccountReferrals(project, "alice", {
					limit: 10,
					cursor: null,
					role: "referrer",
				})
			).items;
			expect(mine).toMatchObject({
				role: "referrer",
				counterpartBillingAccountId: "bob",
				rewards: [{ recipient: "referrer", status: "issued", code: null, reason: null }],
			});
			const [redemption] = await context.sql`
				SELECT redemption.actor, redemption.status, redemption.provider
				FROM promotion_redemptions redemption
				JOIN customers customer ON customer.id = redemption.customer_id
				WHERE customer.billing_account_id = 'alice'
			`;
			expect(redemption).toMatchObject({
				actor: "system:referral",
				status: "applied",
				provider: "quotum",
			});
		});

		it("rewards both sides and shows each account only its own", async () => {
			await program(credits, { recipient: "both" });
			await accounts("alice", "bob");

			const { referral } = await redeem("bob", await codeOf("alice"));

			expect(await rewardCredits("alice")).toBe(25);
			expect(await rewardCredits("bob")).toBe(25);
			expect(referral.rewards.map((reward) => reward.recipient)).toEqual(["referee"]);

			const ledger = await referrals().listProgramReferrals(project, "friends", {
				limit: 10,
				cursor: null,
			});
			expect(ledger.items).toHaveLength(1);
			expect(ledger.items[0]).toMatchObject({
				referrerBillingAccountId: "alice",
				refereeBillingAccountId: "bob",
			});
			expect(ledger.items[0]?.rewards.map((reward) => reward.recipient)).toEqual([
				"referrer",
				"referee",
			]);
		});

		it("answers a repeat of the same code without a second reward", async () => {
			await program(credits, { recipient: "both" });
			await accounts("alice", "bob");
			const code = await codeOf("alice");

			const first = await redeem("bob", code);
			const repeat = await redeem("bob", code.toLowerCase());

			expect(repeat.duplicate).toBe(true);
			expect(repeat.referral.id).toBe(first.referral.id);
			expect(await rewardCredits("alice")).toBe(25);
			expect(await rewardCredits("bob")).toBe(25);
		});

		it("records one referrer per account per program", async () => {
			await program(credits);
			await accounts("alice", "carol", "bob");
			await redeem("bob", await codeOf("alice"));

			expect(await refusal(async () => redeem("bob", await codeOf("carol")))).toBe(
				"REFERRAL_ALREADY_REDEEMED",
			);
			expect(await rewardCredits("carol")).toBe(0);
		});

		it("refuses self-referral, a cycle, an unknown code and an unknown account", async () => {
			await program(credits);
			await accounts("alice", "bob");
			const alice = await codeOf("alice");
			const bob = await codeOf("bob");
			expect(await refusal(() => redeem("alice", alice))).toBe("REFERRAL_SELF");

			await redeem("bob", alice);

			expect(await refusal(() => redeem("alice", bob))).toBe("REFERRAL_CYCLE");
			expect(await refusal(() => redeem("bob", "AAAAAAAA"))).toBe("REFERRAL_CODE_NOT_FOUND");
			expect(await refusal(() => redeem("bob", "bad!"))).toBe("REFERRAL_CODE_NOT_FOUND");
			expect(await refusal(() => redeem("stranger", alice))).toBe("BILLING_ACCOUNT_NOT_FOUND");
		});

		it("refuses an account that has already paid, and an archived program", async () => {
			await program(credits);
			await accounts("alice", "bob", "carol");
			const code = await codeOf("alice");
			await paySubscription("bob");

			expect(await refusal(() => redeem("bob", code))).toBe("REFERRAL_NOT_NEW_CUSTOMER");

			await referrals().archiveProgram(project, "friends", actor);

			expect(await refusal(() => redeem("carol", code))).toBe("REFERRAL_PROGRAM_ARCHIVED");
		});

		it("refuses iOS entry only when the referee would receive a reward", async () => {
			await program(credits, { recipient: "referrer" });
			await accounts("alice", "bob");
			const { referral } = await redeem("bob", await codeOf("alice"), "ios");
			expect(referral.status).toBe("qualified");
			expect(await rewardCredits("alice")).toBe(25);

			await referrals().archiveProgram(project, "friends", actor);
			await referrals().createProgram(project, {
				key: "both-sides",
				name: "Both sides",
				rewardPromotionKey: "reward",
				trigger: "redemption",
				recipient: "both",
				actor,
			});
			await accounts("carol", "dave");
			const code = await codeOf("carol", "both-sides");

			expect(await refusal(() => redeem("dave", code, "ios"))).toBe(
				"PROMOTION_CODE_CHANNEL_NOT_SUPPORTED",
			);
		});

		it("skips the referrer past the cap and still rewards the referee", async () => {
			await program(credits, { recipient: "both", cap: 1 });
			await accounts("alice", "bob", "carol");
			const code = await codeOf("alice");

			await redeem("bob", code);
			await redeem("carol", code);

			expect(await rewardCredits("alice")).toBe(25);
			expect(await rewardCredits("carol")).toBe(25);
			const [latest] = (
				await referrals().listAccountReferrals(project, "alice", {
					limit: 1,
					cursor: null,
					role: "referrer",
				})
			).items;
			expect(latest?.rewards[0]).toMatchObject({
				status: "skipped",
				reason: "REFERRER_LIMIT_REACHED",
			});
		});

		it("holds the cap under concurrent redemptions", async () => {
			await program(credits, { cap: 2 });
			const referees = ["r1", "r2", "r3", "r4", "r5", "r6"];
			await accounts("alice", ...referees);
			const code = await codeOf("alice");

			await Promise.all(referees.map((referee) => redeem(referee, code)));

			expect(await rewardCredits("alice")).toBe(50);
			const [counts] = await context.sql`
				SELECT
					count(*) FILTER (WHERE status = 'issued')::int AS issued,
					count(*) FILTER (WHERE status = 'skipped')::int AS skipped
				FROM referral_rewards
			`;
			expect(counts).toEqual({ issued: 2, skipped: 4 });
		});

		it("finishes reciprocal redemptions without a deadlock", async () => {
			await program(credits, { recipient: "both" });
			await accounts("alice", "bob");
			const [alice, bob] = await Promise.all([codeOf("alice"), codeOf("bob")]);

			const results = await Promise.allSettled([redeem("bob", alice), redeem("alice", bob)]);

			const refused = results
				.filter((result) => result.status === "rejected")
				.map((result) => (result.reason as { code: string }).code);
			expect(refused.every((code) => code === "REFERRAL_CYCLE")).toBe(true);
			expect(results.some((result) => result.status === "fulfilled")).toBe(true);
		});
	});

	describe("rewards that cannot be granted at once", () => {
		it("holds a discount as a code only its recipient can use", async () => {
			await program(discount);
			await accounts("alice", "bob");

			await redeem("bob", await codeOf("alice"));

			const list = () =>
				referrals().listAccountReferrals(project, "alice", {
					limit: 1,
					cursor: null,
					role: "referrer",
				});
			const held = (await list()).items[0]?.rewards[0];
			expect(held).toMatchObject({
				status: "held",
				reason: "DISCOUNT_CODE",
				effectKind: "discount",
			});
			const code = held?.code ?? "";
			expect(code).toMatch(/^[2-9A-Z-]{24}$/);
			expect(
				(
					await context.repository.promotions.validatePromotionCode(project, {
						billingAccountId: "alice",
						code,
						channel: "web",
					})
				).valid,
			).toBe(true);
			expect(
				(
					await context.repository.promotions.validatePromotionCode(project, {
						billingAccountId: "bob",
						code,
						channel: "web",
					})
				).reason,
			).toBe("PROMOTION_CODE_NOT_FOUND");
		});

		it("holds a plan for a paying referrer as a code, and reports it used once redeemed", async () => {
			await program(premiumMonth);
			await accounts("alice", "bob");
			await paySubscription("alice");

			await redeem("bob", await codeOf("alice"));

			const list = async () =>
				(
					await referrals().listAccountReferrals(project, "alice", {
						limit: 1,
						cursor: null,
						role: "referrer",
					})
				).items[0]?.rewards[0];
			const held = await list();
			expect(held).toMatchObject({ status: "held", reason: "PROMOTION_BASE_PLAN_ACTIVE" });

			// The subscription ended, so the code the referrer kept now gives the plan.
			await context.sql`
				UPDATE subscriptions SET status = 'expired'
				WHERE project_id = ${projectId} AND external_subscription_id = 'sub_alice'
			`;
			const redeemed = await context.repository.promotions.redeemPromotionCode(project, {
				billingAccountId: "alice",
				code: held?.code ?? "",
				channel: "web",
				idempotencyKey: "later",
				actor: null,
			});

			expect(redeemed.kind).toBe("plan_granted");
			expect(await list()).toMatchObject({ status: "used", code: null });
		});

		it("lists reward codes apart from an operator's", async () => {
			await program(discount);
			await context.repository.promotions.addPromotionCodes(
				project,
				"reward",
				[{ code: "OPERATOR" }],
				actor,
			);
			await accounts("alice", "bob");
			await redeem("bob", await codeOf("alice"));

			const list = async (source: "operator" | "referral") =>
				(
					await context.repository.promotions.listPromotionCodes(project, "reward", {
						limit: 10,
						source,
					})
				).items.map((code) => code.createdBy);

			expect(await list("operator")).toEqual([actor]);
			expect(await list("referral")).toEqual(["system:referral"]);
		});

		it("grants a plan at once to a referrer with no paid plan", async () => {
			await program(premiumMonth);
			await accounts("alice", "bob");

			await redeem("bob", await codeOf("alice"));

			const [grant] = await context.sql`
				SELECT grants.status, grants.origin
				FROM plan_grants grants
				JOIN customers customer ON customer.id = grants.customer_id
				WHERE customer.billing_account_id = 'alice'
			`;
			expect(grant).toMatchObject({ status: "active", origin: "promotion" });
		});

		it("fails a reward whose promotion was archived, and keeps the referral", async () => {
			await program(credits);
			await accounts("alice", "bob");
			await context.sql`UPDATE referral_programs SET status = 'archived', archived_at = now(), archived_by = 'x'`;
			await context.sql`UPDATE promotions SET status = 'archived', archived_at = now(), archived_by = 'x'`;
			await context.sql`UPDATE referral_programs SET status = 'active', archived_at = NULL, archived_by = NULL`;

			const { referral } = await redeem("bob", await codeOf("alice"));

			expect(referral.status).toBe("qualified");
			const [reward] = await context.sql`SELECT status, reason FROM referral_rewards`;
			expect(reward).toEqual({ status: "failed", reason: "PROMOTION_ARCHIVED" });
		});
	});

	describe("the sweep", () => {
		it("issues what the inline attempt could not, once", async () => {
			await program(credits, { recipient: "both" });
			await accounts("alice", "bob");
			const flaky = new ReferralRepository(
				context.db as never,
				{
					redeemPromotionCode: async () => {
						throw new Error("connection reset");
					},
				} as never,
			);

			const { referral } = await flaky.redeemCode(project, {
				billingAccountId: "bob",
				code: await codeOf("alice"),
				channel: "web",
			});

			expect(referral.rewards[0]?.status).toBe("pending");
			expect(await rewardCredits("alice")).toBe(0);

			const due = await referrals().listDueRewards(10);
			expect(due).toHaveLength(2);
			for (const job of due) await referrals().issueReward(project, job.rewardId);
			for (const job of due) await referrals().issueReward(project, job.rewardId);

			expect(await rewardCredits("alice")).toBe(25);
			expect(await rewardCredits("bob")).toBe(25);
			expect(await referrals().listDueRewards(10)).toEqual([]);
		});

		it("backs off, then gives up", async () => {
			await program(credits);
			await accounts("alice", "bob");
			const flaky = new ReferralRepository(
				context.db as never,
				{
					redeemPromotionCode: async () => {
						throw new Error("connection reset");
					},
				} as never,
			);
			await flaky.redeemCode(project, {
				billingAccountId: "bob",
				code: await codeOf("alice"),
				channel: "web",
			});
			const [job] = await referrals().listDueRewards(10);
			if (job === undefined) throw new Error("no reward is due");

			await referrals().deferReward(projectId, job.rewardId, {
				error: "connection reset",
				retryDelayMs: 60_000,
			});
			expect(await referrals().listDueRewards(10)).toEqual([]);

			await referrals().deferReward(projectId, job.rewardId, {
				error: "connection reset",
				retryDelayMs: null,
			});
			const [row] = await context.sql`SELECT status, reason, attempts FROM referral_rewards`;
			expect(row).toEqual({ status: "failed", reason: "connection reset", attempts: 2 });
		});
	});

	describe("afterwards", () => {
		it("takes a reward back through the existing revoke", async () => {
			await program(credits);
			await accounts("alice", "bob");
			await redeem("bob", await codeOf("alice"));
			const [{ id }] = await context.sql`SELECT id FROM promotion_redemptions`;

			const revoked = await context.repository.promotions.revokePromotionRedemption(project, {
				redemptionId: id,
				reason: "abuse",
				actor,
				idempotencyKey: "revoke-1",
			});

			expect(revoked.redemption.status).toBe("reversed");
			const [allocation] = await context.sql`
				SELECT quantity, reversed_quantity FROM balance_allocations WHERE source_kind = 'reward'
			`;
			expect(Number(allocation.reversed_quantity)).toBe(25);
		});

		it("records an event that names only the recipient's own account", async () => {
			await subscribeToEveryEvent(context.sql, projectId);
			await program(credits, { recipient: "both" });
			await accounts("alice", "bob");

			await redeem("bob", await codeOf("alice"));

			const events = await recordedEvents(context.sql, projectId, "referral.reward_issued");
			expect(
				events
					.map((event) => [
						event.envelope.billingAccountId,
						(event.data.reward as { recipient: string }).recipient,
					])
					.sort(),
			).toEqual([
				["alice", "referrer"],
				["bob", "referee"],
			]);
			expect(JSON.stringify(events[0]?.data)).not.toContain("alice");
			expect(JSON.stringify(events[0]?.data)).not.toContain("bob");
		});

		it("lists account referrals by role with a cursor", async () => {
			await program(credits);
			await accounts("alice", "bob", "carol", "dave");
			const code = await codeOf("alice");
			await redeem("bob", code);
			await redeem("carol", code);
			await redeem("alice", await codeOf("dave"));

			const list = (role: "referrer" | "referee" | null, cursor: string | null = null) =>
				referrals().listAccountReferrals(project, "alice", { limit: 1, cursor, role });

			const first = await list("referrer");
			const second = await list("referrer", first.nextCursor);
			expect(first.items[0]?.counterpartBillingAccountId).toBe("carol");
			expect(second.items[0]?.counterpartBillingAccountId).toBe("bob");
			expect(second.nextCursor).toBeNull();
			expect((await list("referee")).items[0]).toMatchObject({
				role: "referee",
				counterpartBillingAccountId: "dave",
			});
			expect(
				(
					await referrals().listAccountReferrals(project, "alice", {
						limit: 10,
						cursor: null,
						role: null,
					})
				).items,
			).toHaveLength(3);
		});
	});
});
