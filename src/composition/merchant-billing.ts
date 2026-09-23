import { z } from "zod";
import * as queries from "../admin/query";
import type { AdminBillingReader, AdminListResult } from "../admin/types";
import { previewSchema, publishSchema } from "../app/catalog-routes";
import { contractBody, controlBody, migrationBody } from "../app/controls-routes";
import {
	commercialActionExecuteBodySchema,
	commercialActionPreviewBodySchema,
} from "../app/customer-routes";
import {
	dateRange,
	parseUsageEventsRangeAndCursor,
	projectUsageEventsQuerySchema,
	usageEventsQuerySchema,
	usageSeriesQuerySchema,
} from "../app/insights-routes";
import {
	balanceParamsSchema,
	correctionBodySchema,
	operationParamsSchema,
	usageBodySchema,
	usageInput,
} from "../app/metering-routes";
import {
	addPromotionCodesBodySchema,
	createPromotionBodySchema,
	createPromotionInput,
	listAccountRedemptionsQuerySchema,
	listPromotionCodesQuerySchema,
	listPromotionRedemptionsQuerySchema,
	listPromotionsQuerySchema,
	promotionCodeInputs,
	revokePromotionRedemptionBodySchema,
} from "../app/promotion-routes";
import { requireProviderMethod, requireStripeBillingService } from "../app/provider-services";
import type { ProjectProviderServiceResolver } from "../app/types";
import {
	BillingError,
	classifyBillingError,
	InvalidRequestError,
	isBillingError,
} from "../billing/errors";
import { encodeUsageCursor } from "../billing/insights";
import { MeteringService } from "../billing/metering";
import type { BillingRepository } from "../db/repository";
import type { BillingAdminOperations } from "../operations/admin";
import type {
	MerchantBillingCommand,
	MerchantBillingPort,
} from "../platform/application/billing-port";
import { isTenantTrafficEligible, type ProjectInstanceContextResolver } from "../projects/context";
import type { ProviderCapabilityReads } from "../providers/capability-read-types";

export function createMerchantBillingPort(input: {
	repository: BillingRepository;
	reader: AdminBillingReader;
	resolver: ProjectInstanceContextResolver;
	providers: ProjectProviderServiceResolver;
	capabilityReads: ProviderCapabilityReads;
	operations?: BillingAdminOperations | null;
}): MerchantBillingPort {
	const { repository: repo, reader, resolver, providers, capabilityReads } = input;
	const meter = new MeteringService(repo);
	const run = async (command: MerchantBillingCommand) => {
		const resolved = await resolver.resolveInstanceId(command.projectInstanceId);
		if (
			resolved.kind !== "resolved" ||
			(!isTenantTrafficEligible(resolved.context) &&
				!(
					resolved.context.lifecycleStatus === "inactive" &&
					!resolved.context.internalProject &&
					[
						"catalog",
						"catalog.products",
						"catalog.store-products",
						"catalog.preview",
						"catalog.publish",
					].includes(command.operation)
				))
		)
			throw new BillingError("The selected environment is unavailable", "CONTEXT_UNAVAILABLE", 404);
		const project = resolved.context;
		const [id = "", event = ""] = command.parameters;
		const query = new URLSearchParams(command.query);
		const { actor } = command;
		const account = () => queries.parseBillingAccountIdParam(id);
		const ok = (data: unknown, status = 200) => ({ status, body: { success: true, data } });
		const list = <T>(result: AdminListResult<T>) => ({
			status: 200,
			body: { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } },
		});
		const operations = () => {
			if (!input.operations)
				throw new BillingError(
					"Billing operations are not configured",
					"BILLING_ADMIN_NOT_CONFIGURED",
					501,
				);
			return input.operations;
		};
		const stripe = async () =>
			requireStripeBillingService(await providers.stripeBillingService(project));
		switch (command.operation) {
			case "stripe.catalog": {
				const service = await stripe();
				return ok(
					await requireProviderMethod(
						service,
						"stripe",
						"reads.catalog",
						"Stripe catalog is not available",
					)(),
				);
			}
			case "usage.balance": {
				const params = parse(balanceParamsSchema, { billingAccountId: id, featureKey: event });
				return ok(
					await meter.getBalance(
						project,
						params.billingAccountId,
						params.featureKey,
						query.get("entityId"),
					),
				);
			}
			case "usage.operation":
				return ok(
					await meter.getOperation(
						project,
						parse(operationParamsSchema, {
							billingAccountId: id,
							operation: event,
							operationId: command.parameters[2],
						}),
					),
				);
			case "usage.check":
				return ok(
					await meter.check(project, {
						billingAccountId: account(),
						...usageInput(parse(usageBodySchema, command.body)),
					}),
				);
			case "stats":
				return ok(await reader.getStatsSummary(project, queries.parseStatsSummaryQuery(query)));
			case "customers.search":
				return list(await reader.searchCustomers(project, queries.parseCustomerSearchQuery(query)));
			case "customers.account":
				return ok(await reader.getCustomerByBillingAccountId(project, account()));
			case "customers.detail":
				return ok(await reader.getCustomerById(project, queries.parseCustomerIdParam(id)));
			case "customers.purchases":
				return list(
					await reader.listPurchases(project, queries.parseCustomerPurchaseListQuery(id, query)),
				);
			case "customers.subscriptions":
				return list(
					await reader.listSubscriptions(
						project,
						queries.parseCustomerSubscriptionListQuery(id, query),
					),
				);
			case "customers.events":
				return list(
					await reader.listStoreEvents(
						project,
						queries.parseCustomerStoreEventListQuery(id, query),
					),
				);
			case "customers.projections":
				return list(
					await reader.listProjectionJobs(
						project,
						queries.parseCustomerProjectionJobListQuery(id, query),
					),
				);
			case "purchases":
				return list(await reader.listPurchases(project, queries.parsePurchaseListQuery(query)));
			case "subscriptions":
				return list(
					await reader.listSubscriptions(project, queries.parseSubscriptionListQuery(query)),
				);
			case "events":
				return list(await reader.listStoreEvents(project, queries.parseStoreEventListQuery(query)));
			case "events.detail":
				return ok(
					await reader.getStoreEvent(project, {
						eventId: queries.parseEventIdParam(id),
						...queries.parseStoreEventDetailQuery(query),
					}),
				);
			case "projections":
				return list(
					await reader.listProjectionJobs(project, queries.parseProjectionJobListQuery(query)),
				);
			case "catalog":
				return ok(await repo.getPublishedCatalog(project));
			case "catalog.products":
				return list(
					await reader.listCatalogProducts(project, queries.parseCatalogProductListQuery(query)),
				);
			case "catalog.store-products":
				return list(
					await reader.listCatalogStoreProducts(
						project,
						queries.parseCatalogStoreProductListQuery(query),
					),
				);
			case "providers.capabilities":
				return ok(await capabilityReads.environment(project));
			case "catalog.preview":
				return ok(
					await repo.previewCatalog(project, { ...parse(previewSchema, command.body), actor }),
				);
			case "catalog.publish":
				return ok(
					await repo.publishCatalog(project, { ...parse(publishSchema, command.body), actor }),
				);
			case "account.summary":
				return ok(await repo.getCustomerBillingSummary(project, account()));
			case "account.billing": {
				const getBillingAccount = requireProviderMethod(
					await stripe(),
					"stripe",
					"reads.billingAccount",
					"Billing account is unavailable",
				);
				return ok(await getBillingAccount(account()));
			}
			case "account.actions":
				return ok(await capabilityReads.availableActions(project, account()));
			case "controls": {
				const q = parse(
					z.object({ entityId: z.string().trim().min(1).max(200).optional() }).strict(),
					command.query,
				);
				return ok(
					await repo.controlsEnterprise.listEffectiveControls(project, account(), q.entityId),
				);
			}
			case "controls.write": {
				const body = parse(controlBody, command.body);
				return ok(
					await repo.controlsEnterprise.upsertControl(project, {
						billingAccountId: account(),
						...body,
						featureKey: body.featureKey ?? null,
						currency: body.currency ?? null,
						actor,
					}),
				);
			}
			case "usage.events": {
				const body = parse(usageEventsQuerySchema, command.query);
				const { from, to, cursor } = parseUsageEventsRangeAndCursor(body);
				const page = await repo.listUsageEvents(project, {
					...body,
					from,
					to,
					billingAccountId: account(),
					cursor,
				});
				return {
					status: 200,
					body: {
						success: true,
						data: page.items,
						pagination: {
							nextCursor: page.nextCursor === null ? null : encodeUsageCursor(page.nextCursor),
						},
					},
				};
			}
			case "usage-events": {
				const body = parse(projectUsageEventsQuerySchema, command.query);
				const { from, to, cursor } = parseUsageEventsRangeAndCursor(body);
				const page = await repo.listProjectUsageEvents(project, {
					...body,
					from,
					to,
					cursor,
				});
				return {
					status: 200,
					body: {
						success: true,
						data: page.items,
						pagination: {
							nextCursor: page.nextCursor === null ? null : encodeUsageCursor(page.nextCursor),
						},
					},
				};
			}
			case "usage.series": {
				const body = parse(usageSeriesQuerySchema, command.query);
				const range = dateRange(body.from, body.to, 90);
				const points = await repo.getUsageSeries(project, {
					...body,
					...range,
					billingAccountId: account(),
				});
				return {
					status: 200,
					body: {
						success: true,
						data: points,
						meta: {
							from: range.from.toISOString(),
							to: range.to.toISOString(),
							interval: body.interval,
						},
					},
				};
			}
			case "usage.correct": {
				const body = parse(correctionBodySchema, command.body);
				return ok(
					await meter.correct(project, {
						billingAccountId: account(),
						originalUsageEventId: parse(z.uuid(), event),
						originalRecordedAt: new Date(body.originalRecordedAt),
						quantity: body.quantity,
						reason: body.reason,
						metadata: body.metadata,
						occurredAt: body.occurredAt == null ? body.occurredAt : new Date(body.occurredAt),
						actor,
						idempotencyKey: requireKey(command),
					}),
				);
			}
			case "events.replay":
				return ok(await operations().replayStoreEvent(project, queries.parseEventIdParam(id)));
			case "projections.retry":
				return ok(await operations().retryProjectionSyncJob(project, parse(z.uuid(), id)));
			case "contracts.preview":
			case "contracts.publish": {
				const body = parse(
					command.operation === "contracts.publish"
						? contractBody.extend({ previewToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
						: contractBody,
					command.body,
				);
				const contract = {
					...body,
					effectiveAt: new Date(body.effectiveAt),
					expiresAt: body.expiresAt == null ? null : new Date(body.expiresAt),
					controls: body.controls?.map((c) => ({
						...c,
						featureKey: c.featureKey ?? null,
						currency: c.currency ?? null,
					})),
					actor,
				};
				if (command.operation === "contracts.preview")
					return ok(await repo.controlsEnterprise.previewEnterpriseContract(project, contract));
				return ok(
					await repo.controlsEnterprise.publishEnterpriseContract(project, {
						...contract,
						previewToken: parse(
							z.object({ previewToken: z.string().regex(/^[a-f0-9]{64}$/) }),
							command.body,
						).previewToken,
					}),
				);
			}
			case "migrations.preview":
				return ok(
					await repo.controlsEnterprise.previewCatalogMigration(project, {
						...parse(migrationBody, command.body),
						actor,
					}),
				);
			case "migrations.publish":
				return ok(
					await repo.controlsEnterprise.publishCatalogMigration(project, {
						...parse(
							migrationBody.extend({ previewToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
							command.body,
						),
						actor,
					}),
				);
			case "promotions": {
				const input = parse(listPromotionsQuerySchema, command.query);
				return list(
					await repo.promotions.listPromotions(project, {
						limit: input.limit,
						cursor: input.cursor ?? null,
						status: input.status ?? null,
					}),
				);
			}
			case "promotions.detail":
				return ok(await repo.promotions.getPromotion(project, id));
			case "promotions.codes": {
				const input = parse(listPromotionCodesQuerySchema, command.query);
				return list(
					await repo.promotions.listPromotionCodes(project, id, {
						limit: input.limit,
						cursor: input.cursor ?? null,
						active: input.active === undefined ? null : input.active === "true",
					}),
				);
			}
			case "promotions.redemptions": {
				const input = parse(listPromotionRedemptionsQuerySchema, command.query);
				return list(
					await repo.promotions.listPromotionRedemptions(project, id, {
						limit: input.limit,
						cursor: input.cursor ?? null,
						status: input.status ?? null,
						billingAccountId: input.billingAccountId ?? null,
					}),
				);
			}
			case "promotions.create": {
				const result = await repo.promotions.createPromotion(
					project,
					createPromotionInput(parse(createPromotionBodySchema, command.body), actor),
				);
				return ok(result.promotion, result.created ? 201 : 200);
			}
			case "promotions.archive":
				return ok(await repo.promotions.archivePromotion(project, id, actor));
			case "account.promotion-redemptions": {
				const input = parse(listAccountRedemptionsQuerySchema, command.query);
				return list(
					await repo.promotions.listAccountRedemptions(project, account(), {
						limit: input.limit,
						cursor: input.cursor ?? null,
					}),
				);
			}
			case "promotions.redemptions.revoke": {
				const body = parse(revokePromotionRedemptionBodySchema, command.body);
				return ok(
					await repo.promotions.revokePromotionRedemption(project, {
						redemptionId: parse(z.uuid(), id),
						reason: body.reason,
						actor,
						idempotencyKey: requireKey(command),
					}),
				);
			}
			case "promotions.sync":
				return ok(await repo.promotions.requestPromotionProviderSync(project, id, actor));
			case "promotions.codes.add":
				return ok(
					await repo.promotions.addPromotionCodes(
						project,
						id,
						promotionCodeInputs(parse(addPromotionCodesBodySchema, command.body).codes),
						actor,
					),
				);
			case "promotions.codes.deactivate":
				return ok(
					await repo.promotions.deactivatePromotionCode(project, id, parse(z.uuid(), event), actor),
				);
			case "account.payment-setup": {
				const getPaymentSetupSession = requireProviderMethod(
					await stripe(),
					"stripe",
					"paymentMethods.setupSession",
					"Payment method setup is unavailable",
				);
				return ok(await getPaymentSetupSession({ billingAccountId: account(), sessionId: event }));
			}
			case "commercial.preview": {
				const body = parse(commercialActionPreviewBodySchema, command.body);
				const previewCommercialAction = requireProviderMethod(
					await stripe(),
					"stripe",
					"commercial.preview",
					"Commercial previews are unavailable",
				);
				return ok(
					await previewCommercialAction({
						billingAccountId: account(),
						intent: body.intent,
					}),
				);
			}
			case "commercial.execute": {
				const body = parse(commercialActionExecuteBodySchema, command.body);
				const executeCommercialAction = requireProviderMethod(
					await stripe(),
					"stripe",
					"commercial.execute",
					"Commercial actions are unavailable",
				);
				const result = await executeCommercialAction({
					billingAccountId: account(),
					previewToken: body.previewToken,
					idempotencyKey: requireKey(command),
				});
				// Mirrors the /v1 route: only a queued subscription change is accepted for later work.
				return ok(result, result.kind === "subscription_change" ? 202 : 200);
			}
		}
	};
	return {
		async dispatch(command) {
			try {
				return await run(command);
			} catch (error) {
				if (isBillingError(error)) {
					const { status, code, message, details } = classifyBillingError(error);
					return {
						status,
						body: {
							success: false,
							error: { code, message, ...(details === undefined ? {} : { details }) },
						},
					};
				}
				throw error;
			}
		},
	};
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) throw new InvalidRequestError("Invalid billing operation input");
	return result.data;
}
function requireKey(command: MerchantBillingCommand): string {
	const key = command.idempotencyKey?.trim();
	if (!key || key.length > 200) throw new InvalidRequestError("Invalid idempotency key");
	return key;
}
