import type { OpenAPIObject } from "openapi3-ts/oas31";
import { canonicalJson } from "../shared/canonical-json";
import { ERROR_SCHEMA_REF } from "../shared/http";

type Json = Record<string, unknown>;

const REQUEST_BODY_REF = "#/components/requestBodies/";
const RESPONSE_REF = "#/components/responses/";
const PARAMETER_REF = "#/components/parameters/";
const OPERATION_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** Statuses every `/v1` and `/api` operation answers with the shared error envelope. */
export const STANDARD_ERROR_STATUSES = [
	400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 500, 501, 502, 503,
];

/** The response each operation declares for a status in `STANDARD_ERROR_STATUSES`. */
export function standardErrorResponse(status: number): Json {
	return {
		description: `Request failed (${status}); see the error code and request ID.`,
		content: { "application/json": { schema: { $ref: ERROR_SCHEMA_REF } } },
	};
}

/** A request body shorter than this (as compact JSON) stays inline even when operations repeat it. */
const MIN_SHARED_BODY_LENGTH = 1000;

/**
 * Moves what the generated operations repeat into `components`, so the published document spells
 * each part once: the shared error responses, parameters used by several operations, and large
 * request bodies that the merchant copies of `/v1` operations share with their source. The result
 * means the same as the input once the references are followed; `generateOpenApi` keeps the
 * expanded form that the route tests inspect.
 *
 * Request bodies go to `requestBodies`, not `schemas`: generated clients treat a property that has
 * a default as required in a named schema, which would change what a caller must send.
 */
export function shareRepeatedComponents(document: OpenAPIObject): OpenAPIObject {
	const shared = structuredClone(document);
	const operations = Object.entries(shared.paths ?? {}).flatMap(([path, item]) =>
		OPERATION_METHODS.flatMap((method) => {
			const operation = (item as Record<string, unknown> | undefined)?.[method];
			return typeof operation === "object" && operation !== null
				? [{ path, operation: operation as Json }]
				: [];
		}),
	);

	const responses = shareErrorResponses(operations);
	const parameters = shareParameters(operations);
	const requestBodies = shareRequestBodies(operations, shared.components?.requestBodies ?? {});
	shared.components = {
		...shared.components,
		...(Object.keys(responses).length > 0 ? { responses } : {}),
		...(Object.keys(parameters).length > 0 ? { parameters } : {}),
		...(Object.keys(requestBodies).length > 0
			? { requestBodies: { ...shared.components?.requestBodies, ...requestBodies } }
			: {}),
	} as OpenAPIObject["components"];
	return shared;
}

interface PathOperation {
	path: string;
	operation: Json;
}

function shareErrorResponses(operations: readonly PathOperation[]): Record<string, unknown> {
	const standard = new Map(
		STANDARD_ERROR_STATUSES.map((status) => [
			String(status),
			{ name: `QuotumError${status}`, canonical: canonicalJson(standardErrorResponse(status)) },
		]),
	);
	const components: Record<string, unknown> = {};
	for (const { operation } of operations) {
		const responses = operation.responses as Record<string, unknown> | undefined;
		if (responses === undefined) continue;
		for (const [status, response] of Object.entries(responses)) {
			const match = standard.get(status);
			if (match === undefined || canonicalJson(response) !== match.canonical) continue;
			components[match.name] = response;
			responses[status] = { $ref: `${RESPONSE_REF}${match.name}` };
		}
	}
	return components;
}

function shareParameters(operations: readonly PathOperation[]): Record<string, unknown> {
	const seen = new Map<string, { parameter: Json; uses: number }>();
	for (const { operation } of operations)
		for (const parameter of (operation.parameters ?? []) as Json[]) {
			const key = canonicalJson(parameter);
			const entry = seen.get(key) ?? { parameter, uses: 0 };
			entry.uses += 1;
			seen.set(key, entry);
		}

	// `in` + `name` names a parameter; variants of it (another schema, or required in one place and
	// optional in another) are numbered by how often they occur, then by content, so a name stays put.
	const byName = new Map<string, { key: string; parameter: Json; uses: number }[]>();
	for (const [key, entry] of seen) {
		if (entry.uses < 2) continue;
		const name = parameterName(entry.parameter);
		byName.set(name, [...(byName.get(name) ?? []), { key, ...entry }]);
	}
	const names = new Map<string, string>();
	const components: Record<string, unknown> = {};
	for (const [base, variants] of byName) {
		variants.sort((a, b) => b.uses - a.uses || (a.key < b.key ? -1 : 1));
		variants.forEach(({ key, parameter }, index) => {
			const name = index === 0 ? base : `${base}${index + 1}`;
			names.set(key, name);
			components[name] = parameter;
		});
	}

	for (const { operation } of operations) {
		if (!Array.isArray(operation.parameters)) continue;
		operation.parameters = (operation.parameters as Json[]).map((parameter) => {
			const name = names.get(canonicalJson(parameter));
			return name === undefined ? parameter : { $ref: `${PARAMETER_REF}${name}` };
		});
	}
	return components;
}

/** `Header` + `X-CSRF-Token` -> `HeaderXCSRFToken`: component names allow letters, digits, `.`, `_` and `-`. */
function parameterName(parameter: Json): string {
	const words = `${String(parameter.in)}-${String(parameter.name)}`.split(/[^A-Za-z0-9]+/);
	return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

function shareRequestBodies(
	operations: readonly PathOperation[],
	existing: Record<string, unknown>,
): Record<string, unknown> {
	const groups = new Map<string, { requestBody: Json; uses: PathOperation[] }>();
	for (const entry of operations) {
		const requestBody = entry.operation.requestBody as Json | undefined;
		if (requestBody === undefined || "$ref" in requestBody) continue;
		const key = canonicalJson(requestBody);
		if (key.length < MIN_SHARED_BODY_LENGTH) continue;
		const group = groups.get(key) ?? { requestBody, uses: [] };
		group.uses.push(entry);
		groups.set(key, group);
	}

	const components: Record<string, unknown> = {};
	for (const { requestBody, uses } of groups.values()) {
		if (uses.length < 2) continue;
		// The source operation names the body; copies of it (the merchant mirror) point at it.
		const source = uses.find(({ path }) => path.startsWith("/v1/")) ?? uses[0];
		const operationId = source?.operation.operationId;
		if (typeof operationId !== "string") continue;
		const name = `${operationId}Request`;
		if (name in existing || name in components)
			throw new Error(`Cannot share the request body of ${operationId}: component ${name} exists`);
		components[name] = requestBody;
		for (const { operation } of uses)
			operation.requestBody = { $ref: `${REQUEST_BODY_REF}${name}` };
	}
	return components;
}
