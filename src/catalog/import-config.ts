import { z } from "zod";

export interface BillingCatalogDeclaration {
	key: string;
	name: string;
	kind: "subscription" | "topup";
	plan: string | null;
	currency: string;
	amountCents: number;
	credits: number;
	interval: "month" | "year" | null;
	entitlementKey: string;
	externalProductId: string;
	externalPriceId: string;
	active: boolean;
}

export interface ProjectCatalogImport {
	projectInstanceKey: string;
	catalog: BillingCatalogDeclaration[];
}

const catalogDeclarationSchema = z
	.object({
		key: z.string().trim().min(1).max(120),
		name: z.string().trim().min(1).max(120),
		kind: z.enum(["subscription", "topup"]),
		plan: z.string().trim().min(1).max(120).nullable(),
		currency: z
			.string()
			.trim()
			.regex(/^[A-Za-z]{3}$/u)
			.transform((value) => value.toUpperCase()),
		amountCents: z.number().int().positive().max(1_000_000),
		credits: z.number().int().positive().max(100_000),
		interval: z.enum(["month", "year"]).nullable(),
		entitlementKey: z.string().trim().min(1).max(120).default("paid"),
		externalProductId: z.string().trim().min(1).max(256),
		externalPriceId: z.string().trim().min(1).max(256),
		active: z.boolean().default(true),
	})
	.strict()
	.superRefine((declaration, context) => {
		const subscription = declaration.kind === "subscription";
		if (subscription !== (declaration.plan !== null && declaration.interval !== null)) {
			context.addIssue({
				code: "custom",
				message: "subscription catalog items require a plan and billing interval",
			});
		}
		if (!subscription && (declaration.plan !== null || declaration.interval !== null)) {
			context.addIssue({
				code: "custom",
				message: "top-up catalog items cannot contain subscription facts",
			});
		}
	});

const catalogImportSchema = z
	.array(
		z
			.object({
				projectInstanceKey: z
					.string()
					.trim()
					.min(1)
					.max(80)
					.regex(/^[a-z0-9][a-z0-9_-]*$/u),
				catalog: z.array(catalogDeclarationSchema).max(16),
			})
			.strict(),
	)
	.min(1);

export function parseCatalogImports(value: string): ProjectCatalogImport[] {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(value);
	} catch {
		throw new Error("BILLING_CATALOG_IMPORT_JSON must be valid JSON");
	}
	const parsed = catalogImportSchema.safeParse(parsedJson);
	if (!parsed.success) throw new Error("BILLING_CATALOG_IMPORT_JSON is invalid");

	const projectKeys = new Set<string>();
	for (const project of parsed.data) {
		if (projectKeys.has(project.projectInstanceKey)) {
			throw new Error("BILLING_CATALOG_IMPORT_JSON contains duplicate project instance keys");
		}
		projectKeys.add(project.projectInstanceKey);
		if (new Set(project.catalog.map((item) => item.key)).size !== project.catalog.length) {
			throw new Error("BILLING_CATALOG_IMPORT_JSON contains duplicate catalog keys");
		}
	}
	return parsed.data;
}
