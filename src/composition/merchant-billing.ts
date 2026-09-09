import { z } from "zod";
import * as queries from "../admin/query";
import type { AdminBillingReader, AdminListResult } from "../admin/types";
import { previewSchema, publishSchema } from "../app/catalog-routes";
import { contractBody, controlBody, migrationBody } from "../app/controls-routes";
import {
	commercialActionExecuteBodySchema,
	commercialActionPreviewBodySchema,
} from "../app/customer-routes";
import { dateRange, usageEventsQuerySchema, usageSeriesQuerySchema } from "../app/insights-routes";
import { correctionBodySchema } from "../app/metering-routes";
import { requireStripeBillingService } from "../app/provider-services";
import type { ProjectProviderServiceResolver } from "../app/types";
import { BillingError, InvalidRequestError, isBillingError } from "../billing/errors";
import { decodeUsageCursor, encodeUsageCursor } from "../billing/insights";
import { MeteringService } from "../billing/metering";
import type { BillingRepository } from "../db/repository";
import type { BillingAdminOperations } from "../operations/admin";
import type {
	MerchantBillingCommand,
	MerchantBillingPort,
} from "../platform/application/billing-port";
import { isTenantTrafficEligible, type ProjectInstanceContextResolver } from "../projects/context";

export function createMerchantBillingPort(input: {
	repository: BillingRepository;
	reader: AdminBillingReader;
	resolver: ProjectInstanceContextResolver;
	providers: ProjectProviderServiceResolver;
	operations?: BillingAdminOperations | null;
}): MerchantBillingPort {
	const { repository: repo, reader, resolver, providers } = input;
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
				const service = await stripe();
				if (!service.getBillingAccount)
					throw new BillingError("Billing account is unavailable", "STRIPE_NOT_CONFIGURED", 503);
				return ok(await service.getBillingAccount(account()));
			}
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
				const range = dateRange(body.from, body.to, 90);
				const cursor = body.cursor === undefined ? null : decodeUsageCursor(body.cursor);
				if (body.cursor !== undefined && cursor === null)
					throw new InvalidRequestError("Invalid usage cursor");
				const page = await repo.listUsageEvents(project, {
					...body,
					...range,
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
						originalUsageEventId: parse(z.string().uuid(), event),
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
				return ok(await operations().retryProjectionSyncJob(project, parse(z.string().uuid(), id)));
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
			case "commercial.preview": {
				const body = parse(commercialActionPreviewBodySchema, command.body);
				const service = await stripe();
				if (!service.previewCommercialAction)
					throw new BillingError(
						"Commercial previews are unavailable",
						"STRIPE_NOT_CONFIGURED",
						503,
					);
				return ok(
					await service.previewCommercialAction({
						billingAccountId: account(),
						intent: body.intent,
					}),
				);
			}
			case "commercial.execute": {
				const body = parse(commercialActionExecuteBodySchema, command.body);
				const service = await stripe();
				if (!service.executeCommercialAction)
					throw new BillingError(
						"Commercial actions are unavailable",
						"STRIPE_NOT_CONFIGURED",
						503,
					);
				const result = await service.executeCommercialAction({
					billingAccountId: account(),
					previewToken: body.previewToken,
					idempotencyKey: requireKey(command),
				});
				return ok(result, result.kind === "checkout" ? 200 : 202);
			}
		}
	};
	return {
		async dispatch(command) {
			try {
				return await run(command);
			} catch (error) {
				if (isBillingError(error))
					return {
						status: error.status,
						body: {
							success: false,
							error: {
								code: error.code,
								message: error.exposeMessage ? error.message : "Billing request failed",
							},
						},
					};
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
