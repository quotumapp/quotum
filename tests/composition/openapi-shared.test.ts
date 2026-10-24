import { describe, expect, it } from "bun:test";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import { generateOpenApi } from "../../src/composition/openapi";
import {
	shareRepeatedComponents,
	standardErrorResponse,
} from "../../src/composition/openapi-shared";

type Json = Record<string, unknown>;

const largeBody = {
	type: "object",
	properties: Object.fromEntries(
		Array.from({ length: 40 }, (_, index) => [`field${index}`, { type: "string", minLength: 1 }]),
	),
};

function header(name: string, extra: Json = {}): Json {
	return { in: "header", name, required: true, schema: { type: "string" }, ...extra };
}

function document(paths: Record<string, Json>): OpenAPIObject {
	return {
		openapi: "3.1.2",
		info: { title: "Test", version: "0.0.0" },
		paths,
		components: { schemas: { QuotumError: { type: "object" } } },
	} as unknown as OpenAPIObject;
}

function components(shared: OpenAPIObject): Json {
	return (shared.components ?? {}) as unknown as Json;
}

function operations(shared: OpenAPIObject): Record<string, Json> {
	return Object.fromEntries(
		Object.entries(shared.paths ?? {}).map(([path, item]) => [
			path,
			Object.values(item as Json)[0] as Json,
		]),
	);
}

describe("shareRepeatedComponents", () => {
	it("points the standard error responses at shared components and keeps customised ones", () => {
		const shared = shareRepeatedComponents(
			document({
				"/v1/a": {
					get: {
						responses: {
							200: { description: "ok" },
							400: standardErrorResponse(400),
							404: { ...standardErrorResponse(404), description: "No such customer." },
						},
					},
				},
			}),
		);

		expect(operations(shared)["/v1/a"]?.responses).toEqual({
			200: { description: "ok" },
			400: { $ref: "#/components/responses/QuotumError400" },
			404: { ...standardErrorResponse(404), description: "No such customer." },
		});
		expect(components(shared).responses).toEqual({ QuotumError400: standardErrorResponse(400) });
	});

	it("shares parameters several operations use and numbers their variants by use", () => {
		const optional = header("X-Trace", { required: false });
		const shared = shareRepeatedComponents(
			document({
				"/v1/a": { get: { parameters: [header("X-Trace"), header("X-Once")], responses: {} } },
				"/v1/b": { get: { parameters: [header("X-Trace"), optional], responses: {} } },
				"/v1/c": { get: { parameters: [header("X-Trace"), optional], responses: {} } },
				"/v1/d": { get: { parameters: [header("X-Trace")], responses: {} } },
			}),
		);

		expect(components(shared).parameters).toEqual({
			HeaderXTrace: header("X-Trace"),
			HeaderXTrace2: optional,
		});
		expect(operations(shared)["/v1/a"]?.parameters).toEqual([
			{ $ref: "#/components/parameters/HeaderXTrace" },
			header("X-Once"),
		]);
		expect(operations(shared)["/v1/b"]?.parameters).toEqual([
			{ $ref: "#/components/parameters/HeaderXTrace" },
			{ $ref: "#/components/parameters/HeaderXTrace2" },
		]);
	});

	it("names a request body after its /v1 operation and points the merchant copy at it", () => {
		const body = (schema: Json) => ({
			required: true,
			content: { "application/json": { schema } },
		});
		const shared = shareRepeatedComponents(
			document({
				"/api/billing/thing": {
					post: { operationId: "merchantPostThing", requestBody: body(largeBody), responses: {} },
				},
				"/v1/thing": {
					post: { operationId: "postThing", requestBody: body(largeBody), responses: {} },
				},
				"/v1/small": {
					post: { operationId: "postSmall", requestBody: body({ type: "object" }), responses: {} },
				},
				"/api/billing/small": {
					post: {
						operationId: "merchantPostSmall",
						requestBody: body({ type: "object" }),
						responses: {},
					},
				},
			}),
		);

		expect(components(shared).requestBodies).toEqual({ postThingRequest: body(largeBody) });
		for (const path of ["/api/billing/thing", "/v1/thing"])
			expect(operations(shared)[path]?.requestBody).toEqual({
				$ref: "#/components/requestBodies/postThingRequest",
			});
		expect(operations(shared)["/v1/small"]?.requestBody).toEqual(body({ type: "object" }));
	});

	it("keeps a body used once inline and refuses a name that is already taken", () => {
		const body = { content: { "application/json": { schema: largeBody } } };
		const once = shareRepeatedComponents(
			document({
				"/v1/one": { post: { operationId: "postOne", requestBody: body, responses: {} } },
			}),
		);
		expect(components(once).requestBodies).toBeUndefined();

		const clash = document({
			"/v1/one": { post: { operationId: "postOne", requestBody: body, responses: {} } },
			"/v1/two": { post: { operationId: "postTwo", requestBody: body, responses: {} } },
		});
		clash.components = { requestBodies: { postOneRequest: { content: {} } } };
		expect(() => shareRepeatedComponents(clash)).toThrow("postOneRequest exists");
	});

	it("leaves its input untouched", () => {
		const input = document({
			"/v1/a": { get: { responses: { 400: standardErrorResponse(400) } } },
		});
		const before = structuredClone(input);
		shareRepeatedComponents(input);
		expect(input).toEqual(before);
	});

	it("means the same as the generated document once its references are followed", async () => {
		const generated = await generateOpenApi("0.0.0-test");
		const shared = shareRepeatedComponents(generated);
		const root = shared as unknown as Json;
		const follow = (reference: string): unknown =>
			reference
				.slice(2)
				.split("/")
				.reduce<unknown>((node, key) => (node as Json)[key], root);
		const expand = (operation: Json): Json => {
			const expanded = structuredClone(operation);
			if (Array.isArray(expanded.parameters))
				expanded.parameters = expanded.parameters.map((parameter: Json) =>
					typeof parameter.$ref === "string" ? follow(parameter.$ref) : parameter,
				);
			expanded.responses = Object.fromEntries(
				Object.entries(expanded.responses as Json).map(([status, response]) => [
					status,
					typeof (response as Json).$ref === "string"
						? follow((response as Json).$ref as string)
						: response,
				]),
			);
			const body = expanded.requestBody as Json | undefined;
			if (typeof body?.$ref === "string") expanded.requestBody = follow(body.$ref);
			return expanded;
		};

		const expandedPaths = Object.fromEntries(
			Object.entries(shared.paths ?? {}).map(([path, item]) => [
				path,
				Object.fromEntries(
					Object.entries(item as Json).map(([method, operation]) => [
						method,
						typeof operation === "object" && operation !== null
							? expand(operation as Json)
							: operation,
					]),
				),
			]),
		);
		expect(expandedPaths as unknown).toEqual(generated.paths as unknown);
		expect(shared.components?.schemas as unknown).toEqual(generated.components?.schemas as unknown);

		// The point of sharing: no operation spells an error envelope, and the catalog bodies appear once.
		expect(JSON.stringify(shared.paths)).not.toContain("Request failed");
		expect(Object.keys(components(shared).responses as Json)).toHaveLength(14);
		expect(Object.keys(components(shared).requestBodies as Json)).toContain(
			"postV1AdminCatalogPublishRequest",
		);
	});
});
