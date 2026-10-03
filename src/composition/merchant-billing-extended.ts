import { z } from "zod";
import {
	administrativeDebitBodySchema,
	operatorGrantBodySchema,
	operatorGrantRevokeBodySchema,
} from "../app/balance-adjustment-routes";
import {
	alertBody,
	autoTopupBody,
	entityBody,
	postV1BillingAccountsByBillingAccountIdLicenseAssignmentsBodySchema as licenseBody,
} from "../app/controls-routes";
import { redeemPromotionCodeBodySchema } from "../app/promotion-routes";
import { endTrialBodySchema, startTrialBodySchema } from "../app/trial-routes";
import { InvalidRequestError } from "../billing/errors";
import type { BillingRepository } from "../db/repository";
import type { MerchantBillingCommand } from "../platform/application/billing-port";
import type { ProjectInstanceContext } from "../projects/context";

export async function dispatchExtendedBilling(
	repo: BillingRepository,
	project: ProjectInstanceContext,
	c: MerchantBillingCommand,
) {
	const [billingAccountId = "", id = ""] = c.parameters;
	const actor = c.actor;
	const key = () => {
		if (!c.idempotencyKey) throw new InvalidRequestError("An idempotency key is required");
		return c.idempotencyKey;
	};
	const parse = <T>(schema: z.ZodType<T>): T => {
		const value = schema.safeParse(c.body);
		if (!value.success) throw new InvalidRequestError("Request validation failed");
		return value.data;
	};
	const ok = (data: unknown, status = 200) => ({ status, body: { success: true, data } });
	const controls = repo.controlsEnterprise;
	const page = { limit: 25, cursor: null as string | null };
	if (["grants", "debits", "trials"].includes(c.operation)) {
		const parsed = z
			.object({
				limit: z.coerce.number().int().min(1).max(25).default(25),
				cursor: z.string().min(1).max(500).optional(),
			})
			.strict()
			.safeParse(c.query);
		if (!parsed.success) throw new InvalidRequestError("Invalid pagination");
		page.limit = parsed.data.limit;
		page.cursor = parsed.data.cursor ?? null;
	}
	switch (c.operation) {
		case "entities":
			return ok(await controls.listEntities(project, billingAccountId));
		case "entities.write":
			return ok(
				await controls.createEntity(project, { billingAccountId, ...parse(entityBody) }),
				201,
			);
		case "grants.create": {
			const b = parse(operatorGrantBodySchema);
			return ok(
				await repo.balanceAdjustments.grantOperatorBalance(project, {
					...b,
					billingAccountId,
					entityId: b.entityId ?? null,
					expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
					actor,
					idempotencyKey: key(),
				}),
			);
		}
		case "grants.revoke":
			return ok(
				await repo.balanceAdjustments.revokeOperatorGrant(project, {
					billingAccountId,
					grantId: id,
					...parse(operatorGrantRevokeBodySchema),
					actor,
					idempotencyKey: key(),
				}),
			);
		case "grants":
			if (id)
				return ok(await repo.balanceAdjustments.getOperatorGrant(project, billingAccountId, id));
			return ok(await repo.balanceAdjustments.listOperatorGrants(project, billingAccountId, page));
		case "debits.create":
			return ok(
				await repo.balanceAdjustments.debitAllocations(project, {
					billingAccountId,
					...parse(administrativeDebitBodySchema),
					actor,
					idempotencyKey: key(),
				}),
			);
		case "debits":
			return ok(
				await repo.balanceAdjustments.listAdministrativeDebits(project, billingAccountId, page),
			);
		case "trials.start": {
			const b = parse(startTrialBodySchema);
			return ok(
				await repo.planGrants.startTrial(project, {
					billingAccountId,
					planKey: b.planKey,
					durationDays: b.durationDays ?? null,
					metadata: b.metadata ?? {},
					actor,
					idempotencyKey: key(),
				}),
			);
		}
		case "trials.end":
			return ok(
				await repo.planGrants.endTrial(project, {
					billingAccountId,
					trialId: id,
					reason: parse(endTrialBodySchema)?.reason ?? null,
					actor,
					idempotencyKey: key(),
				}),
			);
		case "trials":
			return ok(await repo.planGrants.listTrials(project, billingAccountId, page));
		case "alerts.create":
			return ok(
				await controls.createUsageAlert(project, { billingAccountId, ...parse(alertBody), actor }),
			);
		case "alerts":
			return ok(await controls.listUsageAlerts(project, billingAccountId));
		case "topups.write":
			return ok(
				await controls.upsertAutoTopupPolicy(project, {
					billingAccountId,
					...parse(autoTopupBody),
					actor,
				}),
			);
		case "topups":
			return ok(
				await controls.getAutoTopupPolicy(
					project,
					billingAccountId,
					c.query.featureKey ?? "",
					c.query.entityId ?? null,
				),
			);
		case "topups.reset":
			return ok(await controls.resetAutoTopupCircuit(project, billingAccountId, id, actor));
		case "licenses.assign":
			return ok(
				await controls.assignLicense(project, { billingAccountId, ...parse(licenseBody), actor }),
			);
		case "licenses.release":
			return ok(
				await controls.revokeLicense(project, { billingAccountId, assignmentId: id, actor }),
			);
		case "licenses":
			return ok(await controls.listLicensePools(project, billingAccountId));
		case "contracts":
			return ok(await controls.listEnterpriseContracts(project, billingAccountId));
		case "contracts.terminate":
			return ok(await controls.terminateEnterpriseContract(project, billingAccountId, id, actor));
		case "promotions.redeem":
			return ok(
				await repo.promotions.redeemPromotionCode(project, {
					billingAccountId,
					...parse(redeemPromotionCodeBodySchema),
					actor,
					idempotencyKey: key(),
				}),
			);
		default:
			throw new InvalidRequestError("Unsupported billing operation");
	}
}
