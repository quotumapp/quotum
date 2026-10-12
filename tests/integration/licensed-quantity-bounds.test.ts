import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedPhase3CatalogMigration, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

/** The largest value of a Postgres `integer`, which holds a subscription item quantity. */
const largest = 2_147_483_647;

let context: LocalPostgresContext;

type Fixture = ReturnType<typeof createIntegrationApp>;

describeLocalPostgres(describe, describe.skip)(
	"licensed quantities stay within the integer range",
	() => {
		beforeAll(async () => {
			context = await createLocalPostgresContext();
		});
		beforeEach(async () => {
			await resetAndSeedIntegrationData(context.sql);
			await seedPhase3ControlCatalog(context.sql);
			await seedPhase3CatalogMigration(context.sql);
			await context.sql`
			INSERT INTO provider_plan_bindings (
				project_id, plan_version_id, store_product_id, provider, channel, status
			)
			SELECT price.project_id, price.plan_version_id, binding.store_product_id,
				'stripe', 'web', 'published'
			FROM price_components price
			JOIN provider_price_bindings binding
				ON binding.project_id = price.project_id AND binding.price_component_id = price.id
			WHERE price.key = 'base'
		`;
			// A seat price with no configured maximum is what the integer bound has to cover.
			await context.sql`UPDATE price_components SET maximum_quantity = NULL WHERE key = 'seats'`;
		});
		afterAll(async () => {
			await context.sql.close();
		});

		function fixture(): Fixture {
			return createIntegrationApp({ env: context.env, repository: context.repository });
		}

		function post(
			{ app, authHeaders }: Fixture,
			path: string,
			body: unknown,
			headers: Record<string, string> = {},
		) {
			return testRequest(app, path, {
				method: "POST",
				headers: {
					...(authHeaders("acme") as Record<string, string>),
					"content-type": "application/json",
					...headers,
				},
				body: JSON.stringify(body),
			});
		}

		const previewPath = (account: string) =>
			`/v1/billing-accounts/${account}/commercial-actions/preview`;
		const executePath = (account: string) => `/v1/billing-accounts/${account}/commercial-actions`;
		const changeIntent = (seats: number) => ({
			kind: "subscription_change",
			externalSubscriptionId: "sub_migrate_stripe",
			targetPlanKey: "migration-plan",
			quantities: { licensed_seats: seats },
			effectiveMode: "immediate",
		});
		const checkoutIntent = (seats: number) => ({
			kind: "checkout_plan",
			planKey: "migration-plan",
			quantities: { licensed_seats: seats },
		});

		async function expectInvalidQuantity(response: Response, mentions?: string) {
			const body = await response.json();
			expect({ status: response.status, code: body.error?.code }).toEqual({
				status: 400,
				code: "INVALID_QUANTITY",
			});
			if (mentions !== undefined) expect(body.error.message).toContain(mentions);
		}

		async function count(table: "subscription_changes" | "commercial_action_previews") {
			const [row] =
				table === "subscription_changes"
					? await context.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM subscription_changes`
					: await context.sql<
							{ n: string }[]
						>`SELECT count(*)::text AS n FROM commercial_action_previews`;
			return Number(row?.n);
		}

		it("refuses a subscription_change preview above the range and executes the largest quantity", async () => {
			const app = fixture();

			for (const seats of [largest + 1, Number.MAX_SAFE_INTEGER]) {
				await expectInvalidQuantity(
					await post(app, previewPath("migration-stripe"), { intent: changeIntent(seats) }),
					`cannot exceed ${largest}`,
				);
			}
			expect(await count("commercial_action_previews")).toBe(0);

			const preview = await post(app, previewPath("migration-stripe"), {
				intent: changeIntent(largest),
			});
			expect(preview.status).toBe(200);
			const data = (await preview.json()).data;
			expect(data.lineItems.find((item: { key: string }) => item.key === "seats")).toMatchObject({
				quantity: largest,
			});
			// A total the preview states must be one a JavaScript number holds exactly.
			expect(Number.isSafeInteger(data.nextCycle.subtotalMinor)).toBe(true);

			const executed = await post(
				app,
				executePath("migration-stripe"),
				{ previewToken: data.previewToken },
				{ "idempotency-key": "largest-seats" },
			);
			expect(executed.status).toBe(202);
			const [stored] = await context.sql<{ requested_quantities: Record<string, number> }[]>`
			SELECT requested_quantities FROM subscription_changes
		`;
			expect(stored?.requested_quantities).toEqual({ licensed_seats: largest });
		});

		it("refuses the direct subscription changes route above the range", async () => {
			const app = fixture();
			const change = (seats: number, key: string) =>
				post(
					app,
					"/v1/billing-accounts/migration-stripe/subscriptions/sub_migrate_stripe/changes",
					{
						targetPlanKey: "migration-plan",
						quantities: { licensed_seats: seats },
						effectiveMode: "immediate",
					},
					{ "idempotency-key": key },
				);

			await expectInvalidQuantity(
				await change(largest + 1, "over-range"),
				`cannot exceed ${largest}`,
			);
			expect(await count("subscription_changes")).toBe(0);

			const accepted = await change(largest, "largest-range");
			expect(accepted.status).toBe(202);
			const [stored] = await context.sql<{ requested_quantities: Record<string, number> }[]>`
			SELECT requested_quantities FROM subscription_changes
		`;
			expect(stored?.requested_quantities).toEqual({ licensed_seats: largest });
		});

		it("refuses Checkout above the range through the Stripe route and the commercial action", async () => {
			const app = fixture();

			await expectInvalidQuantity(
				await post(
					app,
					"/v1/billing-accounts/checkout-account/providers/stripe/checkout-sessions",
					{ planKey: "migration-plan", quantities: { licensed_seats: largest + 1 } },
					{ "idempotency-key": "route-over-range" },
				),
				`cannot exceed ${largest}`,
			);
			await expectInvalidQuantity(
				await post(app, previewPath("checkout-account"), { intent: checkoutIntent(largest + 1) }),
				`cannot exceed ${largest}`,
			);
			expect(app.stripe.checkoutSessionParams).toHaveLength(0);
			expect(await count("commercial_action_previews")).toBe(0);

			const preview = await post(app, previewPath("checkout-account"), {
				intent: checkoutIntent(largest),
			});
			expect(preview.status).toBe(200);
			const data = (await preview.json()).data;
			expect(data).toMatchObject({ amountStatus: "exact" });
			expect(Number.isSafeInteger(data.subtotalMinor)).toBe(true);
			const executed = await post(
				app,
				executePath("checkout-account"),
				{ previewToken: data.previewToken },
				{ "idempotency-key": "largest-checkout" },
			);
			expect(executed.status).toBe(200);
			expect(app.stripe.checkoutSessionParams.at(-1)?.line_items).toContainEqual({
				price: "price_migrate_v2_seats",
				quantity: largest,
			});
		});

		it("refuses to execute a stored preview whose quantity no longer fits", async () => {
			const app = fixture();
			const preview = await post(app, previewPath("checkout-account"), {
				intent: checkoutIntent(5),
			});
			expect(preview.status).toBe(200);
			const { previewToken } = (await preview.json()).data;
			// A preview stored before the bound existed carries the quantity the caller sent.
			await context.sql`
			UPDATE commercial_action_previews
			SET intent = jsonb_set(intent, '{quantities,licensed_seats}', ${String(largest + 1)}::jsonb)
		`;

			await expectInvalidQuantity(
				await post(
					app,
					executePath("checkout-account"),
					{ previewToken },
					{ "idempotency-key": "stale-over-range" },
				),
			);
			expect(app.stripe.checkoutSessionParams).toHaveLength(0);
		});

		it("refuses a preview whose flat total a JavaScript number cannot hold exactly", async () => {
			await context.sql`UPDATE price_components SET unit_amount_minor = 5000000 WHERE key = 'seats'`;
			const app = fixture();

			// 5,000,000 minor units a seat at 2,147,483,647 seats is about 1.07e16, past 2^53 - 1.
			await expectInvalidQuantity(
				await post(app, previewPath("migration-stripe"), { intent: changeIntent(largest) }),
				"exceeds 9007199254740991 minor units",
			);
			await expectInvalidQuantity(
				await post(app, previewPath("checkout-account"), { intent: checkoutIntent(largest) }),
				"exceeds 9007199254740991 minor units",
			);

			const fits = await post(app, previewPath("checkout-account"), {
				intent: checkoutIntent(1_000_000_000),
			});
			expect(fits.status).toBe(200);
			const data = (await fits.json()).data;
			const base = data.lineItems.find((item: { key: string }) => item.key === "base");
			expect(data.subtotalMinor).toBe(base.unitAmountMinor + 5_000_000 * 1_000_000_000);
		});
	},
);
