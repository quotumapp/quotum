import type { z } from "zod";
import { previewSchema, publishSchema } from "../../app/catalog-routes";
import { BillingError, InvalidRequestError } from "../../billing/errors";
import { bindingAdoptionSchema, type CatalogBindingsLike } from "../../catalog/bindings";
import type { BillingRepository } from "../../db/repository";
import type { ProjectInstanceContext } from "../../projects/context";
import { BillingApiError } from "../../sdk/client";
import { describeRequestIssues, requestIssues } from "../../shared/request-issues";
import type { CatalogApi } from "./catalog";

export interface DirectCatalogDependencies {
	repository: Pick<BillingRepository, "getPublishedCatalog" | "previewCatalog" | "publishCatalog">;
	bindings: CatalogBindingsLike;
	project: ProjectInstanceContext;
	/** The operator's name; catalog revisions and binding receipts record it as `operator:<name>`. */
	operator: string;
	/**
	 * Checks that the operator may read (`false`) or change (`true`) this instance, and throws when
	 * not. It runs before every operation, so no operation reaches the database unauthorized.
	 */
	authorize(write: boolean): Promise<void>;
}

/**
 * The catalog operations `quotum catalog` needs, served from the database instead of `/v1`. They are
 * the repository calls the merchant billing port makes for the console, so an environment that
 * `/v1` refuses (an inactive one has no project key) is reached the way the console reaches it.
 * Input is validated by the schemas the HTTP routes use, and a refusal comes back as the same
 * `BillingApiError` the HTTP client throws, so the command reports it identically.
 */
export function createDirectCatalogApi(dependencies: DirectCatalogDependencies): CatalogApi {
	const { repository, bindings, project, operator, authorize } = dependencies;
	const actor = `operator:${operator}`;
	return {
		status: () =>
			refusedAsHttp(async () => {
				await authorize(false);
				return await repository.getPublishedCatalog(project);
			}),
		// A preview is stored, so it is a change.
		preview: (input) =>
			refusedAsHttp(async () => {
				await authorize(true);
				return await repository.previewCatalog(project, {
					...parseBody(previewSchema, input),
					actor,
				});
			}),
		publish: (input) =>
			refusedAsHttp(async () => {
				await authorize(true);
				return await repository.publishCatalog(project, {
					...parseBody(publishSchema, input),
					actor,
				});
			}),
		bindings: {
			list: () =>
				refusedAsHttp(async () => {
					await authorize(false);
					return await bindings.list(project);
				}),
			adopt: (input, idempotencyKey) =>
				refusedAsHttp(async () => {
					await authorize(true);
					return await bindings.adopt(
						project,
						parseBody(bindingAdoptionSchema, input),
						actor,
						idempotencyKey,
					);
				}),
		},
	};
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		const { issues } = result.error;
		throw new InvalidRequestError(
			describeRequestIssues(
				"Request validation failed",
				requestIssues("body", issues),
				issues.length,
			),
		);
	}
	return result.data;
}

/** A domain refusal as the client would have thrown it from the HTTP envelope. */
async function refusedAsHttp<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof BillingError)
			throw new BillingApiError(error.message, error.code, error.status, error.details);
		throw error;
	}
}
