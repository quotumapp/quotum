import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { OpenAPIObject, OperationObject } from "openapi3-ts/oas31";
import { generateOpenApi } from "../../src/composition/openapi";
import { MERCHANT_AUTH_POST_PATHS } from "../../src/platform/app";
import { merchantBillingOperations } from "../../src/platform/application/billing-port";
import { TeamViewSchema } from "../../src/platform/schemas";
import { plannedProviders } from "../../src/shared/provider-capabilities";

const METHODS = ["get", "post", "put", "delete", "patch"] as const;

function operations(document: OpenAPIObject) {
	return Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
		METHODS.flatMap((method) => {
			const operation = (item as Record<string, OperationObject | undefined> | undefined)?.[method];
			return operation ? [{ path, method, operation }] : [];
		}),
	);
}

/** The BFF surface the merchant billing rewrites must land on, in OpenAPI path syntax. */
function merchantDocumentPath(suffix: string): string {
	return `/api/billing${suffix.startsWith("/billing-accounts/") ? "/admin" : ""}${suffix}`.replace(
		/:([A-Za-z][A-Za-z0-9]*)/g,
		"{$1}",
	);
}

test("exports each declared operation once, including delegated auth and billing", async () => {
	const document = await generateOpenApi("0.0.0-test");
	const all = operations(document);
	// Registration-only generation: the generator refuses routes without operationDetail metadata.
	for (const { path, method, operation } of all) {
		const label = `${method.toUpperCase()} ${path}`;
		expect(operation.operationId, label).toBeString();
		expect(operation.tags?.join(","), label).toBeString();
		expect(Object.keys(operation.responses ?? {}).join(","), label).toBeString();
	}
	expect(new Set(all.map((entry) => entry.operation.operationId)).size).toBe(all.length);

	const merchantPaths = Object.entries(document.paths ?? {}).filter(([path]) =>
		path.startsWith("/api/billing"),
	);
	const merchantOperations = merchantPaths.flatMap(([path, item]) =>
		operations({ paths: { [path]: item } } as OpenAPIObject).map(
			(entry) => `${entry.method} ${path}`,
		),
	);
	expect(merchantOperations.sort()).toEqual(
		merchantBillingOperations
			.map(([method, suffix]) => `${method.toLowerCase()} ${merchantDocumentPath(suffix)}`)
			.sort(),
	);
	for (const [path, item] of merchantPaths)
		for (const entry of operations({ paths: { [path]: item } } as OpenAPIObject)) {
			const label = `${entry.method.toUpperCase()} ${path}`;
			expect(entry.operation.tags, label).toEqual(["merchant-billing"]);
			expect(entry.operation.operationId?.startsWith("merchant"), label).toBe(true);
			expect(entry.operation.security, label).toEqual([{ serviceToken: [], merchantSession: [] }]);
		}

	expect(
		all
			.filter((entry) => entry.path.startsWith("/api/auth/") && entry.method === "post")
			.map((entry) => entry.path.slice("/api/auth".length))
			.sort(),
	).toEqual([...MERCHANT_AUTH_POST_PATHS].sort());

	expect(all.find((entry) => entry.operation.operationId === "getApiPlatformConfig")?.path).toBe(
		"/api/platform/config",
	);
	const health = document.paths?.["/health"] as
		| Record<string, { operationId?: string }>
		| undefined;
	expect(health?.get?.operationId).toBe("getHealth");

	expect(document.paths?.["/openapi.json"]).toBeUndefined();
	expect(document.paths?.["/api/auth/reference"]).toBeUndefined();
	expect(document.paths?.["/api/billing/admin/reconciliation/subscriptions/run"]).toBeUndefined();
	expect(document.info.version).toBe("0.0.0-test");

	expect(await generateOpenApi("0.0.0-test")).toEqual(document);
});

test("documents nullable onboarding and refuses a missing role policy", async () => {
	const document = await generateOpenApi("0.0.0-test");
	const onboarding = document.paths?.["/api/platform/onboarding"] as
		| Record<
				string,
				{ responses: Record<string, { content?: Record<string, { schema: unknown }> }> }
		  >
		| undefined;
	const schema = onboarding?.get?.responses["200"]?.content?.["application/json"]?.schema;
	expect(schema, "GET /api/platform/onboarding must document its 200 payload").toBeDefined();
	const ajv = new Ajv({ strict: false, allErrors: true });
	addFormats(ajv);
	ajv.addSchema(document, "quotum");
	const validate = ajv.compile({
		$ref: "quotum#/paths/~1api~1platform~1onboarding/get/responses/200/content/application~1json/schema",
	});
	expect(validate({ success: true, data: null })).toBe(true);
	expect(
		TeamViewSchema.safeParse({
			organizationSlug: "acme",
			members: [],
			invitations: [],
			canManage: false,
		}).success,
	).toBe(false);
});

test("documents request bodies, required headers and the named schemas clients import", async () => {
	const document = await generateOpenApi("0.0.0-test");
	const operation = (path: string, method: (typeof METHODS)[number]) => {
		const found = (document.paths?.[path] as Record<string, OperationObject> | undefined)?.[method];
		if (found === undefined) throw new Error(`missing ${method} ${path}`);
		return found;
	};
	const jsonBody = (entry: OperationObject) =>
		(entry.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined)
			?.content?.["application/json"]?.schema;
	const headers = (entry: OperationObject) =>
		(entry.parameters ?? [])
			.map((parameter) => parameter as { in: string; name: string; required?: boolean })
			.filter((parameter) => parameter.in === "header")
			.map((parameter) => `${parameter.name}${parameter.required ? "!" : "?"}`);

	const consume = operation("/v1/billing-accounts/{billingAccountId}/usage/consume", "post");
	expect(jsonBody(consume)).toMatchObject({ required: ["featureKey", "quantity"] });
	expect(headers(consume)).toEqual(["Idempotency-Key!"]);
	const publish = operation("/v1/admin/catalog/publish", "post");
	expect(jsonBody(publish)).toMatchObject({
		required: ["expectedRevision", "previewToken", "catalog"],
	});
	expect(headers(publish)).toEqual(["X-Billing-Actor!"]);
	expect(headers(operation("/v1/admin/promotions", "post"))).toEqual(["X-Billing-Actor!"]);
	expect(headers(operation("/v1/admin/promotions/{promotionKey}", "get"))).toEqual([]);
	expect(
		headers(operation("/v1/billing-accounts/{billingAccountId}/promotion-codes/validate", "post")),
	).toEqual([]);
	expect(jsonBody(operation("/v1/purchases/verify", "post"))).toBeDefined();
	const alertEvents = operation(
		"/v1/billing-accounts/{billingAccountId}/usage-alert-events",
		"get",
	);
	expect(alertEvents.parameters).toContainEqual(
		expect.objectContaining({ in: "query", name: "limit" }),
	);

	const signup = operation("/api/platform/signup-intent", "post");
	expect(jsonBody(signup)).toMatchObject({
		required: ["accepted", "termsVersion", "privacyVersion"],
	});
	expect(headers(signup)).toEqual([
		"X-CSRF-Token!",
		"Idempotency-Key!",
		"X-Quotum-Step-Up-Grant?",
		"Origin!",
	]);
	expect(headers(operation("/api/billing/admin/catalog/publish", "post"))).toContain("Origin!");

	for (const name of [
		"MerchantSessionView",
		"MerchantErrorBody",
		"EntitlementSnapshot",
		"QuotumError",
		"ReadinessBlockerDetail",
	])
		expect(document.components?.schemas?.[name], name).toBeDefined();
	const readiness = operation("/api/platform/environments/readiness", "post");
	expect(
		(
			readiness.responses?.["200"] as
				| {
						content: Record<
							string,
							{ schema: { properties: { data: { properties: Record<string, unknown> } } } }
						>;
				  }
				| undefined
		)?.content["application/json"]?.schema.properties.data.properties.blockerDetails,
	).toEqual({ type: "array", items: { $ref: "#/components/schemas/ReadinessBlockerDetail" } });
	const check = operation("/v1/billing-accounts/{billingAccountId}/usage/check", "post");
	expect(
		(check.responses?.["200"] as { content: Record<string, { schema: unknown }> } | undefined)
			?.content["application/json"]?.schema,
	).toEqual({
		$ref: "#/components/schemas/postV1BillingAccountsByBillingAccountIdUsageCheckResponse200",
	});
	// Success payloads stay open for additive fields unless their schema is declared strict.
	expect(
		document.components?.schemas?.postV1BillingAccountsByBillingAccountIdUsageCheckResponse200,
	).not.toHaveProperty("additionalProperties");
});

/** Declaration-level schemas that name planned providers; no operation may reach them. */
const DECLARATION_ONLY_SCHEMAS = [
	"CapabilityVerdict",
	"ProviderCapabilityDeclaration",
	"ProviderCapabilityMatrix",
];

/** Runtime capability schemas: admitted providers only, embedded by the capability reads. */
const RUNTIME_CAPABILITY_SCHEMAS = [
	"RuntimeCapabilityVerdict",
	"ProviderConnectionSummary",
	"ProviderEnvironmentCapabilities",
	"SubscriptionAvailableActions",
	"BillingAccountAvailableActions",
];

/**
 * Walks every operation's parameters, request body and responses, following `$ref`, and returns
 * the named schemas it reaches plus every planned-provider value found on the way.
 */
function operationReach(document: OpenAPIObject) {
	const schemas = new Set<string>();
	const planned: string[] = [];
	const plannedValues = new Set<string>(plannedProviders);
	const resolved = new Set<string>();
	const visit = (node: unknown, trail: string): void => {
		if (typeof node === "string") {
			if (plannedValues.has(node)) planned.push(`${trail}: ${node}`);
			return;
		}
		if (Array.isArray(node)) {
			node.forEach((item, index) => {
				visit(item, `${trail}/${index}`);
			});
			return;
		}
		if (typeof node !== "object" || node === null) return;
		for (const [key, value] of Object.entries(node)) {
			if (plannedValues.has(key)) planned.push(`${trail}: ${key}`);
			if (key === "$ref" && typeof value === "string") {
				if (resolved.has(value)) continue;
				resolved.add(value);
				const name = /^#\/components\/schemas\/([^/]+)$/.exec(value)?.[1];
				if (name !== undefined) schemas.add(name);
				const target = value
					.slice(2)
					.split("/")
					.reduce<unknown>(
						(parent, segment) =>
							(parent as Record<string, unknown> | undefined)?.[
								segment.replaceAll("~1", "/").replaceAll("~0", "~")
							],
						document,
					);
				if (target === undefined) throw new Error(`${trail}: unresolved ${value}`);
				visit(target, value);
				continue;
			}
			visit(value, `${trail}/${key}`);
		}
	};
	for (const { path, method, operation } of operations(document)) {
		const trail = `${method.toUpperCase()} ${path}`;
		visit(operation.parameters, `${trail} parameters`);
		visit(operation.requestBody, `${trail} requestBody`);
		visit(operation.responses, `${trail} responses`);
	}
	return { schemas, planned };
}

test("no operation reaches declaration-only capability schemas or a planned provider", async () => {
	const document = await generateOpenApi("0.0.0-test");
	for (const name of [...DECLARATION_ONLY_SCHEMAS, ...RUNTIME_CAPABILITY_SCHEMAS])
		expect(document.components?.schemas?.[name], name).toBeDefined();

	const reach = operationReach(document);
	expect(reach.schemas.has("QuotumError")).toBe(true);
	// The runtime capability reads embed verdicts, so the walk must cover them too.
	for (const name of RUNTIME_CAPABILITY_SCHEMAS)
		expect(reach.schemas.has(name), `${name} is reachable`).toBe(true);
	expect(DECLARATION_ONLY_SCHEMAS.filter((name) => reach.schemas.has(name))).toEqual([]);
	expect(reach.planned).toEqual([]);

	// The walk itself must see a declaration schema and its planned provider once a path refers to it.
	const leaked = structuredClone(document);
	const [first] = operations(leaked);
	if (first === undefined) throw new Error("The document has no operations");
	first.operation.responses = {
		...first.operation.responses,
		"299": {
			description: "leak",
			content: {
				"application/json": {
					schema: { $ref: "#/components/schemas/ProviderCapabilityMatrix" },
				},
			},
		},
	};
	const leakedReach = operationReach(leaked);
	expect(leakedReach.schemas.has("ProviderCapabilityMatrix")).toBe(true);
	expect(leakedReach.schemas.has("ProviderCapabilityDeclaration")).toBe(true);
	expect(leakedReach.planned.length).toBeGreaterThan(0);
});

test("new literal routes must register OpenAPI detail metadata", async () => {
	const expectedMounts: Record<string, string[]> = {
		"src/composition/merchant-runtime.ts": ["/api/*", "/*"],
		"src/platform/app.ts": ["/api/auth/*", "/api/billing/*"],
	};
	for await (const path of new Bun.Glob("src/**/*.ts").scan(process.cwd())) {
		const source = await readFile(path, "utf8");
		const wildcardMounts = [...source.matchAll(/\bapp\.all\(\s*"([^"]+)"/g)].map(
			(match) => match[1],
		);
		expect(wildcardMounts, path).toEqual(expectedMounts[path] ?? []);
		for (const match of source.matchAll(/\bapp\.(?:get|post|put|patch|delete)\s*\(/g)) {
			const openParen = source.indexOf("(", match.index);
			const span = callArguments(source, openParen);
			expect(
				/\bdetail\s*:/.test(span) || /\broute\s*\(/.test(span),
				`${path}: ${source.slice(match.index, openParen + 40).replaceAll("\n", " ")} must register detail metadata`,
			).toBe(true);
		}
	}
});

function callArguments(source: string, openParen: number): string {
	let depth = 0;
	for (let index = openParen; index < source.length; index += 1) {
		if (source[index] === "(") depth += 1;
		if (source[index] === ")") {
			depth -= 1;
			if (depth === 0) return source.slice(openParen, index + 1);
		}
	}
	return source.slice(openParen);
}
