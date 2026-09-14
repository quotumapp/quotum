import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { OpenAPIObject } from "openapi3-ts/oas31";

const specification = JSON.parse(
	readFileSync(new URL("../../contracts/v1/openapi.json", import.meta.url), "utf8"),
) as OpenAPIObject;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(specification, "quotum");
const entries = Object.entries(specification.paths ?? {}).sort(
	([a], [b]) => (a.match(/\{/g)?.length ?? 0) - (b.match(/\{/g)?.length ?? 0),
);

export interface OpenApiAssertionOptions {
	allowUndocumented?: boolean;
	requestBody?: unknown;
	requestContentType?: string | null;
}

export async function assertOpenApiResponse(
	method: string,
	path: string,
	response: Response,
	options: OpenApiAssertionOptions = {},
) {
	const pathname = new URL(path, "https://quotum.invalid").pathname;
	const entry = entries.find(([template]) =>
		new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(pathname),
	);
	if (!entry) return; // Negative route tests intentionally exercise paths outside the contract.
	const [template, item] = entry;
	const methodKey = method.toLowerCase();
	const operation = (
		item as Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>
	)[methodKey];
	if (!operation) {
		if (options.allowUndocumented === true) return;
		if (response.status === 404 || response.status === 405) return;
		expect(
			operation,
			`${method} ${template}: undocumented method (${response.status})`,
		).toBeDefined();
		return;
	}
	const declared = operation.responses[String(response.status)] ?? operation.responses.default;
	expect(declared, `${method} ${template}: undocumented ${response.status}`).toBeDefined();
	if (
		response.status >= 200 &&
		response.status < 300 &&
		["post", "put", "patch"].includes(methodKey)
	) {
		assertRequestBody(template, methodKey, options);
	}
	if (!declared?.content) return;
	const media = (response.headers.get("content-type") ?? "").split(";")[0] ?? "";
	expect(
		declared.content[media],
		`${method} ${template}: undocumented media ${media}`,
	).toBeDefined();
	const pointer = `quotum#/paths/${template.replaceAll("~", "~0").replaceAll("/", "~1")}/${methodKey}/responses/${operation.responses[String(response.status)] ? response.status : "default"}/content/${media.replaceAll("/", "~1")}/schema`;
	const validate = ajv.getSchema(pointer) ?? ajv.compile({ $ref: pointer });
	const body =
		media === "application/json" ? await response.clone().json() : await response.clone().text();
	expect(
		validate(body),
		`${method} ${template} ${response.status}: ${ajv.errorsText(validate.errors)}`,
	).toBe(true);
}

export interface HandleableApp {
	handle(request: Request): Promise<Response>;
}

/**
 * Send a test request through an Elysia app. Paths may be root-relative; a localhost origin is
 * implied (Elysia's router only rejects single-character hostnames). A prebuilt Request passes
 * through untouched.
 */
export function testRequest(
	app: HandleableApp,
	path: string | Request,
	init?: RequestInit,
): Promise<Response> {
	if (path instanceof Request) {
		return app.handle(init === undefined ? path : new Request(path, init));
	}
	return app.handle(new Request(new URL(path, "http://localhost"), init));
}

/**
 * Wrap an app so every dispatched request is validated against the checked-in OpenAPI snapshot.
 * Returns the same app with `handle` patched; use `testRequest` (or `app.handle`) to dispatch.
 */
export function withOpenApiAssertions<T extends HandleableApp>(
	app: T,
	options: { allowUndocumented?: boolean } = {},
): T {
	const handle = app.handle.bind(app);
	app.handle = async (request: Request) => {
		const method = request.method;
		const url = request.url;
		const requestContentType = request.headers.get("content-type");
		let requestBody: unknown;
		if (request.body !== null && request.body !== undefined) {
			const cloned = request.clone();
			requestBody = await readRequestBody(cloned, requestContentType);
		}
		const response = await handle(request);
		await assertOpenApiResponse(method, url, response, {
			allowUndocumented: options.allowUndocumented,
			requestBody,
			requestContentType,
		});
		return response;
	};
	return app;
}

function assertRequestBody(
	template: string,
	method: string,
	options: OpenApiAssertionOptions,
): void {
	const pointer = `quotum#/paths/${template.replaceAll("~", "~0").replaceAll("/", "~1")}/${method}/requestBody/content/application~1json/schema`;
	const validate = ajv.getSchema(pointer);
	if (validate === undefined) {
		return;
	}
	const body = options.requestBody;
	if (body === undefined) {
		return;
	}
	expect(
		validate(body),
		`${method.toUpperCase()} ${template} request body: ${ajv.errorsText(validate.errors)}`,
	).toBe(true);
}

async function readRequestBody(request: Request, contentType: string | null): Promise<unknown> {
	const text = await request.text();
	return parseMaybeJson(text, contentType);
}

function parseMaybeJson(text: string, _contentType: string | null): unknown {
	if (text === "") {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
