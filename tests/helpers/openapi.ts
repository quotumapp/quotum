import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Hono } from "hono";
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

export function withOpenApiAssertions<T extends Pick<Hono, "request">>(
	app: T,
	options: { allowUndocumented?: boolean } = {},
): T {
	const request = app.request.bind(app);
	app.request = async (...args: Parameters<typeof request>) => {
		const input = args[0];
		const init = args[1];
		const requestObject = input instanceof Request ? input : undefined;
		const method = init?.method ?? requestObject?.method ?? "GET";
		const url = requestObject?.url ?? String(input);
		const requestContentType =
			requestObject?.headers.get("content-type") ??
			new Headers(init?.headers as HeadersInit | undefined).get("content-type");
		let requestBody: unknown;
		if (requestObject !== undefined) {
			const cloned = requestObject.clone();
			requestBody = await readRequestBody(cloned, requestContentType);
		} else if (typeof init?.body === "string") {
			requestBody = parseMaybeJson(init.body, requestContentType);
		}
		const response = await request(...args);
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
