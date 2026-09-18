import type { Elysia } from "elysia";
import type {
	OpenAPIObject,
	OperationObject,
	ParameterObject,
	PathItemObject,
} from "openapi3-ts/oas31";
import { z } from "zod";
import { createApp } from "../app";
import * as adminResponses from "../app/contracts/admin-responses";
import * as catalogResponses from "../app/contracts/catalog-responses";
import * as controlsResponses from "../app/contracts/controls-responses";
import * as customerResponses from "../app/contracts/customer-responses";
import * as insightsResponses from "../app/contracts/insights-responses";
import * as meteringResponses from "../app/contracts/metering-responses";
import * as promotionResponses from "../app/contracts/promotion-responses";
import * as providerResponses from "../app/contracts/provider-responses";
import type { BillingEnv } from "../env";
import { createMerchantApp } from "../platform/app";
import { createMerchantAuth } from "../platform/auth";
import type { MerchantConnections } from "../platform/connections/service";
import * as platformResponses from "../platform/platform-responses";
import * as platformSchemas from "../platform/schemas";
import { MerchantStore } from "../platform/store";
import type { ProjectInstanceContextResolver } from "../projects/context";
import { errorSchema, OPERATION_DOC, type OperationDoc } from "../shared/http";
import { generateAuthOpenApi } from "./auth-openapi";
import { connectionEventDetail } from "./connection-events";
import { rewriteStaffOperationsForMerchantBilling } from "./merchant-openapi";
import { stripeAppEventDetail } from "./stripe-app-events";

/** Registration-only environment: doc generation never touches the database or network. */
function documentEnv(): BillingEnv {
	return {
		postgresUri: "",
		postgresPreparedStatements: true,
		authMode: "api_key",
		operatorApiKey: null,
		trustGatewayProjectHeader: false,
		runtimeEnvironment: "test",
		workerId: "openapi-document",
		workerPollIntervalMs: 60_000,
		projectionSyncMaxAttempts: 1,
		storeEventReplayMaxAttempts: 1,
		storeEventReplayPollIntervalMs: 60_000,
		subscriptionReconciliationMaxAttempts: 1,
		subscriptionReconciliationPollIntervalMs: 60_000,
		providerReconciliationStaleAfterMs: 60_000,
		meteringMaintenancePollIntervalMs: 60_000,
		rateLimit: {
			windowMs: 60_000,
			verifyLimit: 120,
			webhookLimit: 120,
			adminLimit: 120,
			meteringLimit: 120,
			trustProxyHeaders: false,
		},
		sentry: {
			dsn: null,
			environment: "test",
			release: null,
			enableLogs: false,
			tracesSampleRate: 0,
			logLevel: "error",
			captureExpectedErrors: false,
		},
	};
}

const unavailable = async (): Promise<never> => {
	throw new Error("OpenAPI export must not access persistence or send email");
};

function documentStore(): MerchantStore {
	const sql = Object.assign(unavailable, {
		query: unavailable,
		begin: unavailable,
		instances: { forProject: unavailable, create: unavailable, activateProduction: unavailable },
	});
	return new MerchantStore(sql, {
		signupEnabled: true,
		origin: "https://app.quotum.invalid",
		publicUrl: "https://quotum.invalid",
		secret: "openapi-generation-only-not-a-runtime-secret",
		termsVersion: "current",
		privacyVersion: "current",
		google: { clientId: "openapi-generation-only", clientSecret: "openapi-generation-only" },
		email: null,
		testMode: true,
	});
}

const stubResolver: ProjectInstanceContextResolver = {
	resolveCredential: unavailable,
	resolveInstanceKey: unavailable,
	resolveInstanceId: unavailable,
};

type JsonSchema = Record<string, unknown>;
type SchemaIo = "input" | "output";

const COMPONENT_REF = "#/components/schemas/";
const STANDARD_ERROR_STATUSES = [400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 500, 501, 503];
/** Wildcard mounts that forward to Better Auth and the merchant billing proxy; documented separately. */
const DELEGATED_ROUTES = new Set(["/api/auth/*", "/api/billing/*"]);

/**
 * Shared wire schemas become named components. Response modules export one
 * `<operationId>Response<status>Schema` per operation; merchant view and provider result schemas
 * keep their domain names. Downstream clients import these names, so they are part of the contract.
 */
function schemaNames(): Map<z.ZodType, string> {
	const names = new Map<z.ZodType, string>();
	const add = (module: Record<string, unknown>, exportName: RegExp) => {
		for (const [name, value] of Object.entries(module)) {
			if (value instanceof z.ZodType && exportName.test(name) && !names.has(value))
				names.set(value, name.replace(/Schema$/, ""));
		}
	};
	const domainSchema = /^[A-Z][A-Za-z0-9]*Schema$/;
	add(platformSchemas, domainSchema);
	add(providerResponses, domainSchema);
	for (const module of [
		adminResponses,
		catalogResponses,
		controlsResponses,
		customerResponses,
		insightsResponses,
		meteringResponses,
		platformResponses,
		promotionResponses,
	])
		add(module, /^[A-Za-z][A-Za-z0-9]*Response\d{3}Schema$/);
	return names;
}

/** Renders Zod schemas into OpenAPI 3.1 JSON Schema and collects the named components they use. */
class SchemaRenderer {
	readonly components: Record<string, JsonSchema> = {};
	private readonly registry = z.registry<{ id: string }>();

	constructor(names: ReadonlyMap<z.ZodType, string>) {
		for (const [schema, id] of names) this.registry.add(schema, { id });
	}

	render(schema: z.ZodType, io: SchemaIo): JsonSchema {
		const rendered = z.toJSONSchema(schema, {
			metadata: this.registry,
			io,
			unrepresentable: "any",
			override: ({ zodSchema, jsonSchema }) => {
				const def = zodSchema._zod.def as {
					type: string;
					catchall?: unknown;
					shape?: Record<string, z.ZodType>;
				};
				if (def.type !== "object") return;
				// Zod closes every output object; responses only close objects declared strict.
				if (io === "output" && def.catchall === undefined) delete jsonSchema.additionalProperties;
				// unknown/any members accept undefined, so the key may be absent on the wire.
				const optional = Object.entries(def.shape ?? {})
					.filter(([, member]) => ["unknown", "any"].includes(member._zod.def.type))
					.map(([name]) => name);
				if (Array.isArray(jsonSchema.required) && optional.length > 0) {
					jsonSchema.required = jsonSchema.required.filter((name) => !optional.includes(name));
					if (jsonSchema.required.length === 0) delete jsonSchema.required;
				}
			},
		}) as JsonSchema;
		const { $defs, ...root } = rendered;
		for (const [name, definition] of Object.entries(($defs ?? {}) as Record<string, JsonSchema>))
			this.addComponent(name, definition);
		return rewriteSchema(root) as JsonSchema;
	}

	/** Registers a named schema even when no operation references it. */
	include(schema: z.ZodType, name: string): void {
		if (this.components[name] !== undefined) return;
		// A registered schema renders as a reference and adds itself; anything else is added here.
		const rendered = this.render(schema, "output");
		if (this.components[name] === undefined) this.addComponent(name, rendered);
	}

	private addComponent(name: string, definition: JsonSchema): void {
		if (name.startsWith("__schema"))
			throw new Error(`Unnamed recursive schema "${name}"; name it in schemaNames()`);
		const schema = rewriteSchema(definition) as JsonSchema;
		const existing = this.components[name];
		if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(schema))
			throw new Error(`Component ${name} renders differently for request and response use`);
		this.components[name] = schema;
	}
}

/**
 * Drops generator noise, points local `$defs` references at the shared components, and keeps the
 * published spelling stable for generated clients: literals as single-value enums and nullable
 * scalars as type unions.
 */
function rewriteSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(rewriteSchema);
	if (typeof value !== "object" || value === null) return value;
	const record = nullableScalar(value as Record<string, unknown>);
	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) {
		if (key === "$schema") continue;
		// Formats already say this; z.iso.datetime's pattern is also UTC-only while the wire accepts offsets.
		if (key === "pattern" && ["date-time", "uuid", "email"].includes(String(record.format)))
			continue;
		// Zod spells out bounds the published contract never carried: safe integers and record keys.
		// Record keys are still validated at runtime; oasdiff treats a new key constraint as breaking.
		if (key === "maximum" && child === Number.MAX_SAFE_INTEGER) continue;
		if (key === "minimum" && child === Number.MIN_SAFE_INTEGER) continue;
		if (key === "propertyNames") continue;
		if (key === "$ref" && typeof child === "string" && child.startsWith("#/$defs/")) {
			output[key] = `${COMPONENT_REF}${child.slice("#/$defs/".length)}`;
			continue;
		}
		if (key === "const") {
			output.enum = [child];
			continue;
		}
		output[key] = rewriteSchema(child);
	}
	return output;
}

/**
 * `anyOf: [{ type: "string", ... }, { type: "null" }]` becomes `type: ["string", "null"]`, as the
 * published contract always spelled inline nullable schemas; references keep the `anyOf` form.
 */
function nullableScalar(record: Record<string, unknown>): Record<string, unknown> {
	const { anyOf, ...rest } = record;
	if (!Array.isArray(anyOf) || anyOf.length !== 2) return record;
	const isNull = (entry: unknown) => JSON.stringify(entry) === '{"type":"null"}';
	const nullIndex = anyOf.findIndex(isNull);
	const scalar = anyOf[1 - nullIndex] as Record<string, unknown> | undefined;
	if (nullIndex === -1 || scalar === undefined || typeof scalar.type !== "string") return record;
	const merged: Record<string, unknown> = { ...rest, ...scalar, type: [scalar.type, "null"] };
	if (Array.isArray(scalar.enum)) merged.enum = [...scalar.enum, null];
	if ("const" in scalar) {
		merged.enum = [scalar.const, null];
		delete merged.const;
	}
	return merged;
}

interface DocumentedRoute {
	method: string;
	path: string;
	detail: Record<string, unknown>;
	doc: OperationDoc;
	params?: z.ZodType;
	query?: z.ZodType;
	body?: z.ZodType;
}

function documentedRoutes(apps: readonly Elysia[]): DocumentedRoute[] {
	const routes: DocumentedRoute[] = [];
	for (const app of apps)
		for (const route of app.routes) {
			if (DELEGATED_ROUTES.has(route.path)) continue;
			const hooks = route.hooks as Record<string, unknown>;
			const detail = hooks.detail as Record<string, unknown> | undefined;
			const doc = detail?.[OPERATION_DOC] as OperationDoc | undefined;
			if (detail === undefined || doc === undefined)
				throw new Error(`${route.method} ${route.path} has no operationDetail metadata`);
			if (doc.path !== route.path)
				throw new Error(`${route.method} ${route.path} documents a different path: ${doc.path}`);
			routes.push({
				method: route.method.toLowerCase(),
				path: route.path,
				detail,
				doc,
				params: (hooks.params as z.ZodType | undefined) ?? doc.request?.params,
				query: (hooks.query as z.ZodType | undefined) ?? doc.request?.query,
				body: (hooks.body as z.ZodType | undefined) ?? doc.request?.body,
			});
		}
	return routes;
}

function objectParameters(
	renderer: SchemaRenderer,
	schema: z.ZodType | undefined,
	location: "path" | "query",
): ParameterObject[] {
	if (schema === undefined) return [];
	const rendered = renderer.render(schema, "input");
	const properties = (rendered.properties ?? {}) as Record<string, JsonSchema>;
	const required = new Set((rendered.required ?? []) as string[]);
	return Object.entries(properties).map(([name, property]) => ({
		in: location,
		name,
		required: location === "path" || required.has(name),
		schema: property,
	}));
}

/**
 * Headers every client must send, derived from the surface: merchant mutations carry the browser
 * origin, CSRF token and idempotency key; audited /v1 mutations carry an actor, and durable /v1
 * mutations an idempotency key. The runtime enforces each of these.
 */
function headerParameters(route: DocumentedRoute): ParameterObject[] {
	const tags = (route.detail.tags ?? []) as string[];
	const mutation = route.method !== "get";
	const header = (name: string, required: boolean, schema: JsonSchema = { type: "string" }) => ({
		in: "header" as const,
		name,
		required,
		schema,
	});
	const headers: ParameterObject[] = [];
	if (route.path.startsWith("/api/platform/"))
		headers.push(
			header("X-CSRF-Token", mutation),
			header("Idempotency-Key", mutation),
			header("X-Quotum-Step-Up-Grant", false),
		);
	if (route.path.startsWith("/v1/") && mutation) {
		const actor =
			((tags.includes("catalog") || tags.includes("controls")) &&
				!route.path.endsWith("/entities")) ||
			(tags.includes("promotions") && route.path.startsWith("/v1/admin/")) ||
			route.path.endsWith("/corrections");
		const idempotent =
			(tags.includes("metering") && !route.path.endsWith("/check")) ||
			route.path.endsWith("/commercial-actions") ||
			route.path.endsWith("/changes") ||
			route.path.endsWith("/promotion-redemptions") ||
			route.path.endsWith("/promotion-redemptions/:redemptionId/revoke");
		if (actor)
			headers.push(
				header("X-Billing-Actor", true, { type: "string", minLength: 1, maxLength: 200 }),
			);
		if (route.path.endsWith("/promotion-redemptions"))
			headers.push(
				header("X-Billing-Actor", false, { type: "string", minLength: 1, maxLength: 200 }),
			);
		if (idempotent) headers.push(header("Idempotency-Key", true, { type: "string", minLength: 1 }));
	}
	if (route.path.startsWith("/api/") && mutation) headers.push(header("Origin", true));
	return headers;
}

function pathParameters(renderer: SchemaRenderer, route: DocumentedRoute): ParameterObject[] {
	if (route.params !== undefined) return objectParameters(renderer, route.params, "path");
	return [...route.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => ({
		in: "path" as const,
		name: match[1] ?? "",
		required: true,
		schema: { type: "string" },
	}));
}

function operationObject(renderer: SchemaRenderer, route: DocumentedRoute): OperationObject {
	const { doc, detail } = route;
	const parameters = [
		...pathParameters(renderer, route),
		...objectParameters(renderer, route.query, "query"),
		...headerParameters(route),
	];
	const responses: Record<string, unknown> = {};
	if (route.path.startsWith("/v1/") || route.path.startsWith("/api/"))
		for (const status of STANDARD_ERROR_STATUSES)
			responses[status] = {
				description: `Request failed (${status}); see the error code and request ID.`,
				content: { "application/json": { schema: { $ref: `${COMPONENT_REF}QuotumError` } } },
			};
	for (const [status, schema] of Object.entries(doc.responses))
		responses[status] = {
			description: Number(status) < 400 ? "Successful response" : "Error response",
			content: {
				[doc.contentType ?? "application/json"]: { schema: renderer.render(schema, "output") },
			},
		};
	const { [OPERATION_DOC]: _doc, ...operation } = detail;
	return {
		...operation,
		...(parameters.length > 0 ? { parameters } : {}),
		...(route.body !== undefined && route.method !== "get"
			? {
					requestBody: {
						required: true,
						content: { "application/json": { schema: renderer.render(route.body, "input") } },
					},
				}
			: {}),
		responses,
	} as OperationObject;
}

/**
 * The staff and merchant apps with every route registered against registration-only stubs. The
 * contract is rendered from these apps, and route-table tests inspect the same instances.
 */
export function buildDocumentedApps(): readonly Elysia[] {
	const staff = createApp({ env: documentEnv(), projectContextResolver: stubResolver });
	const store = documentStore();
	// Registration-only stubs: routes are registered against these but never invoked.
	const stubConnections = {} as MerchantConnections;
	const merchant = createMerchantApp({
		store,
		mailer: { send: unavailable },
		auth: createMerchantAuth(store, { send: unavailable }, undefined),
		connections: stubConnections,
	});
	return [staff, merchant];
}

export async function generateOpenApi(version: string) {
	const names = schemaNames();
	const renderer = new SchemaRenderer(names);
	const paths: Record<string, PathItemObject> = {};
	for (const route of [...documentedRoutes(buildDocumentedApps()), ...documentedIngressRoutes()]) {
		const path = route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}");
		paths[path] ??= {};
		const item = paths[path] as Record<string, unknown>;
		if (item[route.method] !== undefined)
			throw new Error(`Duplicate operation: ${route.method.toUpperCase()} ${path}`);
		item[route.method] = operationObject(renderer, route);
	}
	// Merchant views and provider capability schemas are part of the published vocabulary even
	// where no operation embeds them.
	for (const module of [platformSchemas, providerResponses])
		for (const [name, schema] of Object.entries(module))
			if (schema instanceof z.ZodType) renderer.include(schema, name.replace(/Schema$/, ""));

	const document = {
		openapi: "3.1.2",
		info: {
			title: "Quotum API",
			version,
			description: "Complete implemented HTTP contract. Pre-GA; no stable v1 guarantee is implied.",
		},
		paths,
		components: {
			securitySchemes: {
				projectKey: {
					type: "http",
					scheme: "bearer",
					description: "Project-environment API credential; trusted backends only.",
				},
				gatewayProject: {
					type: "apiKey",
					in: "header",
					name: "X-Billing-Project-Key",
					description: "Only accepted from the configured trusted gateway.",
				},
				merchantSession: {
					type: "apiKey",
					in: "cookie",
					name: "__Host-quotum_session",
				},
				serviceToken: {
					type: "apiKey",
					in: "header",
					name: "X-Quotum-Service-Token",
					description: "Added by the server-side BFF, never a browser credential.",
				},
				operatorKey: {
					type: "apiKey",
					in: "header",
					name: "X-Billing-Operator-Key",
				},
				stripeSignature: {
					type: "apiKey",
					in: "header",
					name: "Stripe-Signature",
				},
				googleOidc: {
					type: "http",
					scheme: "bearer",
					bearerFormat: "JWT",
				},
			},
			schemas: {
				...renderer.components,
				QuotumError: renderer.render(errorSchema, "output"),
			},
		},
	} as unknown as OpenAPIObject;
	const auth = await generateAuthOpenApi();
	for (const [path, operation] of Object.entries(auth.paths ?? {})) {
		if (document.paths?.[path]) throw new Error(`Duplicate auth path: ${path}`);
		document.paths = { ...document.paths, [path]: operation };
	}
	for (const [name, schema] of Object.entries(auth.components?.schemas ?? {})) {
		if (document.components?.schemas?.[name]) throw new Error(`Duplicate auth schema: ${name}`);
		document.components = {
			...document.components,
			schemas: { ...document.components?.schemas, [name]: schema },
		};
	}
	for (const [path, item] of Object.entries(
		rewriteStaffOperationsForMerchantBilling(document) as Record<string, PathItemObject>,
	)) {
		if (document.paths?.[path]) throw new Error(`Duplicate merchant billing path: ${path}`);
		document.paths = { ...document.paths, [path]: item };
	}

	document.servers = [
		{
			url: "/",
			description:
				"Relative to the configured API origin; merchant paths are accessed through the BFF.",
		},
	];
	const tags = new Set<string>();
	for (const [path, item] of Object.entries(document.paths ?? {}))
		for (const method of ["get", "post", "put", "delete", "patch"] as const) {
			const operation = item?.[method];
			if (!operation) continue;
			operation.summary ??= `${method.toUpperCase()} ${path}`;
			for (const tag of operation.tags ?? []) tags.add(tag);
		}
	document.tags = [...tags]
		.sort()
		.map((name) => ({ name, description: `Implemented ${name} operations.` }));
	return document;
}

/**
 * The two setup-only webhook ingresses are mounted by the merchant runtime, which needs a
 * database; the document reads their exported metadata instead.
 */
function documentedIngressRoutes(): DocumentedRoute[] {
	return [connectionEventDetail(), stripeAppEventDetail()].map((detail) => {
		const doc = detail[OPERATION_DOC] as OperationDoc;
		return {
			method: "post",
			path: doc.path,
			detail,
			doc,
			params: doc.request?.params,
			body: doc.request?.body,
		};
	});
}
