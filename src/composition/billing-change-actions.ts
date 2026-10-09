import { z } from "zod";
import {
	administrativeDebitBodySchema,
	operatorGrantBodySchema,
	operatorGrantRevokeBodySchema,
} from "../app/balance-adjustment-routes";
import { previewSchema } from "../app/catalog-routes";
import {
	alertBody,
	autoTopupBody,
	contractBody,
	controlBody,
	entityBody,
	postV1BillingAccountsByBillingAccountIdLicenseAssignmentsBodySchema as licenseBody,
	migrationBody,
} from "../app/controls-routes";
import { commercialActionPreviewBodySchema } from "../app/customer-routes";
import { correctionBodySchema } from "../app/metering-routes";
import {
	addPromotionCodesBodySchema,
	createPromotionBodySchema,
	redeemPromotionCodeBodySchema,
	revokePromotionRedemptionBodySchema,
} from "../app/promotion-routes";
import { endTrialBodySchema, startTrialBodySchema } from "../app/trial-routes";
import type { BillingChangeDescriptor } from "../platform/application/billing-changes";
import type { MerchantBillingOperation } from "../platform/application/billing-port";
import { bigintIdSchema, hasUnstorableText } from "../shared/input-bounds";

const text = z.string().trim().min(1).max(200);
// Not z.tuple([]): it emits `prefixItems: []`, which the 2020-12 meta-schema forbids, so clients
// drop the whole prepare_billing_change tool.
const none = z.array(z.string()).max(0);
const account = z.tuple([text]);
const accountUuid = z.tuple([text, z.uuid()]);
const accountId = z.tuple([text, bigintIdSchema()]);
const empty = z.object({}).strict();
interface Action extends BillingChangeDescriptor {
	action: MerchantBillingOperation;
	parameters: z.ZodType<string[]>;
	body: z.ZodType;
	preview?: MerchantBillingOperation;
	read: MerchantBillingOperation;
	external?: boolean;
}
const operation = (
	action: MerchantBillingOperation,
	parameters: z.ZodType<string[]>,
	body: z.ZodType,
	read: MerchantBillingOperation,
	options: Partial<Omit<Action, "action" | "parameters" | "body" | "read">> = {},
): Action => ({
	action,
	parameters,
	body,
	read,
	capability: "operations.write",
	stepUpAction: "operations.write",
	alwaysSensitive: false,
	...options,
});
export const billingChangeActions: readonly Action[] = [
	operation("catalog.publish", none, previewSchema, "catalog", {
		preview: "catalog.preview",
		capability: "catalog.publish.sandbox",
		stepUpAction: "catalog.publish",
	}),
	operation("contracts.publish", none, contractBody, "catalog", { preview: "contracts.preview" }),
	operation("migrations.publish", none, migrationBody, "catalog", {
		preview: "migrations.preview",
	}),
	operation("commercial.execute", account, commercialActionPreviewBodySchema, "account.summary", {
		preview: "commercial.preview",
		external: true,
	}),
	operation("controls.write", account, controlBody, "controls"),
	operation("entities.write", account, entityBody, "entities"),
	operation("grants.create", account, operatorGrantBodySchema, "grants"),
	operation("grants.revoke", accountUuid, operatorGrantRevokeBodySchema, "grants"),
	operation("debits.create", account, administrativeDebitBodySchema, "grants"),
	operation("trials.start", account, startTrialBodySchema, "trials"),
	operation("trials.end", accountUuid, endTrialBodySchema.unwrap(), "trials"),
	operation("alerts.create", account, alertBody, "alerts"),
	operation("topups.write", account, autoTopupBody, "topups"),
	operation("topups.reset", accountId, empty, "account.summary"),
	operation("licenses.assign", account, licenseBody, "licenses"),
	operation("licenses.release", accountId, empty, "licenses"),
	operation("contracts.terminate", accountId, empty, "contracts"),
	operation("promotions.create", none, createPromotionBodySchema, "promotions"),
	operation("promotions.archive", account, empty, "promotions.detail"),
	operation("promotions.sync", account, empty, "promotions.detail"),
	operation("promotions.codes.add", account, addPromotionCodesBodySchema, "promotions.detail"),
	operation("promotions.codes.deactivate", accountUuid, empty, "promotions.detail"),
	operation(
		"promotions.redemptions.revoke",
		z.tuple([z.uuid()]),
		revokePromotionRedemptionBodySchema,
		"catalog",
	),
	operation(
		"promotions.redeem",
		account,
		redeemPromotionCodeBodySchema,
		"account.promotion-redemptions",
	),
	operation("usage.correct", accountUuid, correctionBodySchema, "account.summary", {
		alwaysSensitive: true,
	}),
	operation("events.replay", z.tuple([z.uuid()]), empty, "events.detail", {
		capability: "operations.recover",
		stepUpAction: "operations.recover",
		alwaysSensitive: true,
		external: true,
	}),
	operation("projections.retry", z.tuple([z.uuid()]), empty, "projections", {
		capability: "operations.recover",
		stepUpAction: "operations.recover",
		alwaysSensitive: true,
	}),
];
export const prepareBillingChangeSchema = z
	.object({
		requestKey: text,
		reason: z.string().trim().min(1).max(500),
		replacesChangeId: z.uuid().optional(),
		change: z.union(
			billingChangeActions.map((a) =>
				z.object({ action: z.literal(a.action), parameters: a.parameters, body: a.body }).strict(),
			),
		),
	})
	.strict()
	// Text Postgres cannot store would fail the proposal insert as if the API were unreachable.
	.refine((proposal) => !hasUnstorableText(proposal), {
		message: "Proposal text cannot contain NUL or unpaired surrogate characters",
	});
