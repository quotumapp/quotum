import { sql as drizzleSql } from "drizzle-orm";
import { type BillingDatabase, db as defaultDb } from "../db/client";
import type { BillingEnv } from "../env";
import type { BillingCatalogDeclaration } from "../projects/config";

export async function syncConfiguredProjectsAndCatalog(
	env: Pick<BillingEnv, "projects">,
	database: BillingDatabase = defaultDb,
): Promise<void> {
	await database.transaction(async (tx) => {
		for (const project of env.projects) {
			const rows = await tx.execute<{
				id: string;
				published_catalog_revision_id: string | number | bigint | null;
			}>(drizzleSql`
				INSERT INTO projects (key, name, active)
				VALUES (${project.key}, ${project.key}, ${project.active})
				ON CONFLICT (key) DO UPDATE SET
					active = EXCLUDED.active,
					updated_at = now()
				RETURNING id, published_catalog_revision_id
			`);
			const projectId = rows[0]?.id;
			if (projectId === undefined) {
				throw new Error(`Billing project ${project.key} could not be synchronized`);
			}

			// This command is an explicit development import. Once the versioned control plane has
			// published a revision, the database catalog is authoritative and bootstrap input cannot
			// rewrite or reactivate its provider rows.
			if (rows[0]?.published_catalog_revision_id !== null) {
				continue;
			}

			for (const declaration of project.catalog ?? []) {
				await syncCatalogDeclaration(tx as BillingDatabase, projectId, declaration);
			}
		}
	});
}

async function syncCatalogDeclaration(
	database: BillingDatabase,
	projectId: string,
	declaration: BillingCatalogDeclaration,
): Promise<void> {
	const productRows = await database.execute<{ id: string }>(drizzleSql`
		INSERT INTO products (
			project_id,
			key,
			entitlement_key,
			credit_amount,
			name,
			type,
			active,
			metadata
		)
		VALUES (
			${projectId},
			${declaration.key},
			${declaration.entitlementKey},
			${declaration.credits},
			${declaration.name},
			${declaration.kind === "subscription" ? "subscription" : "consumable"},
			${declaration.active},
			${JSON.stringify({
				schemaVersion: 1,
				catalogKind: declaration.kind,
				plan: declaration.plan,
			})}::jsonb
		)
		ON CONFLICT (project_id, key) DO UPDATE SET
			entitlement_key = EXCLUDED.entitlement_key,
			credit_amount = EXCLUDED.credit_amount,
			name = EXCLUDED.name,
			type = EXCLUDED.type,
			active = EXCLUDED.active,
			metadata = products.metadata || EXCLUDED.metadata,
			updated_at = now()
		RETURNING id
	`);
	const productId = productRows[0]?.id;
	if (productId === undefined) {
		throw new Error(`Billing catalog product ${declaration.key} could not be synchronized`);
	}

	await database.execute(drizzleSql`
		UPDATE store_products
		SET active = false, updated_at = now()
		WHERE project_id = ${projectId}
			AND product_id = ${productId}
			AND provider = 'stripe'
			AND channel = 'web'
			AND (
				external_product_id IS DISTINCT FROM ${declaration.externalProductId}
				OR external_price_id IS DISTINCT FROM ${declaration.externalPriceId}
			)
	`);
	await database.execute(drizzleSql`
		INSERT INTO store_products (
			project_id,
			product_id,
			provider,
			channel,
			external_product_id,
			external_price_id,
			billing_period,
			currency,
			price_amount,
			active,
			metadata
		)
		VALUES (
			${projectId},
			${productId},
			'stripe',
			'web',
			${declaration.externalProductId},
			${declaration.externalPriceId},
			${declaration.interval ?? "one_time"},
			${declaration.currency.toLowerCase()},
			${declaration.amountCents},
			${declaration.active},
			${JSON.stringify({ schemaVersion: 1, catalogKey: declaration.key })}::jsonb
		)
		ON CONFLICT (project_id, provider, external_product_id, external_price_id)
			WHERE external_price_id IS NOT NULL
		DO UPDATE SET
			product_id = EXCLUDED.product_id,
			channel = EXCLUDED.channel,
			billing_period = EXCLUDED.billing_period,
			currency = EXCLUDED.currency,
			price_amount = EXCLUDED.price_amount,
			active = EXCLUDED.active,
			metadata = store_products.metadata || EXCLUDED.metadata,
			updated_at = now()
	`);
}
