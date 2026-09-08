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
export async function assertOpenApiResponse(method: string, path: string, response: Response) {
	const pathname = new URL(path, "https://quotum.invalid").pathname;
	const entry = entries.find(([template]) =>
		new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(pathname),
	);
	if (!entry) return; // Negative route tests intentionally exercise paths outside the contract.
	const [template, item] = entry;
	const operation = (
		item as Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>
	)[method.toLowerCase()];
	if (!operation) return;
	const declared = operation.responses[String(response.status)] ?? operation.responses.default;
	expect(declared, `${method} ${template}: undocumented ${response.status}`).toBeDefined();
	if (!declared?.content) return;
	const media = (response.headers.get("content-type") ?? "").split(";")[0] ?? "";
	expect(
		declared.content[media],
		`${method} ${template}: undocumented media ${media}`,
	).toBeDefined();
	const pointer = `quotum#/paths/${template.replaceAll("~", "~0").replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${operation.responses[String(response.status)] ? response.status : "default"}/content/${media.replaceAll("/", "~1")}/schema`;
	const validate = ajv.getSchema(pointer) ?? ajv.compile({ $ref: pointer });
	const body =
		media === "application/json" ? await response.clone().json() : await response.clone().text();
	expect(
		validate(body),
		`${method} ${template} ${response.status}: ${ajv.errorsText(validate.errors)}`,
	).toBe(true);
}
export function withOpenApiAssertions<T extends Pick<Hono, "request">>(app: T): T {
	const request = app.request.bind(app);
	app.request = async (...args: Parameters<typeof request>) => {
		const response = await request(...args);
		const input = args[0];
		await assertOpenApiResponse(
			args[1]?.method ?? (input instanceof Request ? input.method : "GET"),
			input instanceof Request ? input.url : String(input),
			response,
		);
		return response;
	};
	return app;
}
