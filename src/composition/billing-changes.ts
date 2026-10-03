import { createHash } from "node:crypto";
import { BillingError } from "../billing/errors";
import type { BillingRepository } from "../db/repository";
import type {
	BillingChangeContext,
	BillingChangeInput,
	BillingChangePreview,
	BillingChangesPort,
} from "../platform/application/billing-changes";
import type {
	MerchantBillingCommand,
	MerchantBillingPort,
} from "../platform/application/billing-port";
import { canonicalJson } from "../platform/step-up";
import { billingChangeActions } from "./billing-change-actions";

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export function createBillingChangesPort(
	repo: BillingRepository,
	makePort: (repository: BillingRepository) => MerchantBillingPort,
): BillingChangesPort {
	const port = makePort(repo);
	const descriptor = (input: BillingChangeInput) => {
		const found = billingChangeActions.find((a) => a.action === input.action);
		if (!found) throw new BillingError("Unsupported billing action", "INVALID_REQUEST", 400);
		return found;
	};
	const command = (
		context: BillingChangeContext,
		input: BillingChangeInput,
		key: string | null,
	): MerchantBillingCommand => ({
		...context,
		operation: descriptor(input).action,
		parameters: input.parameters,
		body: input.body,
		query: {},
		idempotencyKey: key,
	});
	const snapshot = async (
		p: MerchantBillingPort,
		context: BillingChangeContext,
		input: BillingChangeInput,
		repository: BillingRepository = repo,
	) => {
		const a = descriptor(input);
		const body = input.body as Record<string, unknown>;
		const cmd = command(context, input, null);
		const query: Record<string, string> = {};
		if (a.read === "topups" && typeof body.featureKey === "string")
			query.featureKey = body.featureKey;
		if (typeof body.entityId === "string") query.entityId = body.entityId;
		const result = await p.dispatch({
			...cmd,
			operation: a.read,
			parameters: input.parameters,
			body: undefined,
			query,
		});
		if (result.status === 404) return null;
		if (result.status >= 400)
			throw new BillingError(
				"Cannot read the target of this change",
				"BILLING_CHANGE_PREVIEW_FAILED",
				result.status,
			);
		const target = await repository.administrationTarget(
			context.projectInstanceId,
			input.action,
			input.parameters,
			input.body,
		);
		return target === null ? result.body : { configuration: result.body, target };
	};
	const prepare = async (
		context: BillingChangeContext,
		requested: BillingChangeInput,
	): Promise<BillingChangePreview> => {
		const a = descriptor(requested);
		const params = a.parameters.safeParse(requested.parameters),
			body = a.body.safeParse(requested.body);
		if (!params.success || !body.success)
			throw new BillingError("Invalid billing change input", "INVALID_REQUEST", 400);
		const input = { action: a.action, parameters: params.data, body: body.data };
		const before = await snapshot(port, context, input);
		if (!a.preview) {
			if (!a.external) {
				const validation = await repo.previewAdministration((repository) =>
					makePort(repository).dispatch(
						command(context, input, `mcp-preview:${crypto.randomUUID()}`),
					),
				);
				if (validation.status >= 400)
					throw new BillingError(
						"The proposed change was rejected by billing validation",
						"BILLING_CHANGE_PREVIEW_FAILED",
						validation.status,
					);
			}
			return { input, before, after: input.body, fingerprint: hash(before) };
		}
		const result = await port.dispatch({ ...command(context, input, null), operation: a.preview });
		if (result.status >= 400)
			throw new BillingError(
				"The billing preview was rejected",
				"BILLING_CHANGE_PREVIEW_FAILED",
				result.status,
				{ details: { response: result.body } },
			);
		const data = (result.body as { data: { previewToken: string; expiresAt?: string } }).data;
		return {
			input,
			before,
			after: Object.fromEntries(Object.entries(data).filter(([key]) => key !== "previewToken")),
			fingerprint: hash(before),
			previewToken: data.previewToken,
			expiresAt: data.expiresAt,
		};
	};
	return {
		actions: billingChangeActions.map(({ action, capability, stepUpAction, alwaysSensitive }) => ({
			action,
			capability,
			stepUpAction,
			alwaysSensitive,
		})),
		async inspect(context, input) {
			const resources = [
				"entities",
				"grants",
				"debits",
				"trials",
				"alerts",
				"topups",
				"licenses",
				"contracts",
				"controls",
				"promotions",
				"promotions.detail",
				"promotions.codes",
				"promotions.redemptions",
				"account.promotion-redemptions",
			] as const;
			const resource = resources.find((value) => value === input.resource);
			if (!resource)
				throw new BillingError("Unsupported configuration resource", "INVALID_REQUEST", 400);
			const result = await port.dispatch({
				...context,
				operation: resource,
				parameters: input.parameters,
				query: input.query,
				body: undefined,
				idempotencyKey: null,
			});
			if (result.status >= 400)
				throw new BillingError(
					"Configuration could not be read",
					"BILLING_CONFIGURATION_UNAVAILABLE",
					result.status,
				);
			return result.body;
		},
		prepare,
		recover: (context, key) => repo.administrationReceipt(context.projectInstanceId, key),
		async apply(context, preview, key) {
			const a = descriptor(preview.input);
			const execute = async (repository: BillingRepository) => {
				const p = makePort(repository);
				if (hash(await snapshot(p, context, preview.input, repository)) !== preview.fingerprint)
					throw new BillingError(
						"The reviewed state changed. Prepare a new proposal.",
						"BILLING_CHANGE_STALE",
						409,
					);
				const cmd = command(context, preview.input, key);
				if (a.preview)
					cmd.body =
						a.action === "commercial.execute"
							? { previewToken: preview.previewToken }
							: { ...(preview.input.body as object), previewToken: preview.previewToken };
				return p.dispatch(cmd);
			};
			if (a.external) {
				// Provider actions retain their own durable key; an uncertain event replay is never blindly rerun.
				return execute(repo);
			}
			try {
				return await repo.withAdministrationReceipt(
					context.projectInstanceId,
					key,
					hash(preview.input),
					execute,
				);
			} catch (error) {
				if (error instanceof BillingError)
					return {
						status: error.status,
						body: { success: false, error: { code: error.code, message: error.message } },
					};
				throw error;
			}
		},
	};
}
