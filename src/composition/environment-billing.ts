import { BillingRepository } from "../db/repository";
import type { EnvironmentBillingPort } from "../platform/connections/ports";
import { MerchantError } from "../platform/security";
import { PostgresProjectInstanceContextResolver } from "./project-instance-persistence";

export function createEnvironmentBillingPort(): EnvironmentBillingPort {
	const repository = new BillingRepository();
	const resolver = new PostgresProjectInstanceContextResolver();
	const context = async (id: string) => {
		const result = await resolver.resolveInstanceId(id);
		if (result.kind !== "resolved")
			throw new MerchantError("CONTEXT_UNAVAILABLE", "Environment is unavailable.", 404);
		return result.context;
	};
	return {
		async catalogReadiness(id) {
			const published = await repository.getPublishedCatalog(await context(id));
			const providers = new Set<string>();
			const inspect = (value: unknown): void => {
				if (!value || typeof value !== "object") return;
				if (Array.isArray(value)) {
					for (const item of value) inspect(item);
					return;
				}
				for (const [key, child] of Object.entries(value)) {
					if (key === "providerBindings" && Array.isArray(child))
						for (const binding of child) {
							if (typeof binding.provider === "string") providers.add(binding.provider);
						}
					else inspect(child);
				}
			};
			inspect(published.catalog);
			return {
				revisionId: published.revisionId,
				ready: published.catalog !== null,
				providers: [...providers],
			};
		},
		async promote(input) {
			const source = await context(input.sourceInstanceId),
				target = await context(input.targetInstanceId);
			if (
				source.logicalProjectId !== target.logicalProjectId ||
				source.environment !== "sandbox" ||
				target.environment !== "production"
			)
				throw new MerchantError(
					"INVALID_PROMOTION",
					"Promotion must stay within the same project.",
				);
			const original = await repository.getPublishedCatalog(source),
				destination = await repository.getPublishedCatalog(target);
			if (!original.catalog)
				throw new MerchantError("CATALOG_REQUIRED", "Publish a sandbox catalog first.", 409);
			// Provider product/price identifiers belong to their environment. The merchant maps live IDs
			// in the ordinary catalog workbench before previewing and publishing the reviewed revision.
			const catalog = JSON.parse(JSON.stringify(original.catalog), (key, value) =>
				key === "providerBindings" ? [] : value,
			);
			return {
				catalog,
				sourceRevisionId: original.revisionId,
				targetRevisionId: destination.revisionId,
			};
		},
	};
}
