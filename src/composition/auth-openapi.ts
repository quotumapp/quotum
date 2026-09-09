import { betterAuth } from "better-auth";
import { openAPI } from "better-auth/plugins";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import { z } from "zod";
import { MERCHANT_AUTH_POST_PATHS, resetPasswordBodySchema } from "../platform/app";
import { createMerchantAuth } from "../platform/auth";
import { MerchantStore } from "../platform/store";

/** Export-only configuration: real auth options/plugins, no persistence or external effects. */
export async function generateAuthOpenApi(): Promise<OpenAPIObject> {
	const unavailable = async (): Promise<never> => {
		throw new Error("OpenAPI export must not access persistence or send email");
	};
	const sql = Object.assign(unavailable, {
		begin: unavailable,
		instances: { forProject: unavailable, create: unavailable, activateProduction: unavailable },
	});
	const store = new MerchantStore(sql, {
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
	const configured = createMerchantAuth(store, { send: unavailable }, undefined);
	const exporter = betterAuth({
		...configured.options,
		plugins: [...(configured.options.plugins ?? []), openAPI({ disableDefaultReference: true })],
	});
	const generated = await exporter.api.generateOpenAPISchema();
	// Better Auth and Hono expose different OpenAPI interface packages for the same JSON document.
	const doc: OpenAPIObject = JSON.parse(JSON.stringify(generated));
	const paths: OpenAPIObject["paths"] = {};
	for (const [path, item] of Object.entries(doc.paths ?? {})) {
		const suffix = path.replace(/^\/api\/auth/, "");
		if (!item) continue;
		if (MERCHANT_AUTH_POST_PATHS.has(suffix) && item.post) {
			const operation = item.post;
			operation.operationId =
				"auth" +
				suffix
					.split(/[^A-Za-z0-9]+/)
					.filter(Boolean)
					.map((x) => x[0]?.toUpperCase() + x.slice(1))
					.join("");
			operation.tags = ["authentication"];
			if (suffix === "/reset-password")
				operation.requestBody = {
					required: true,
					content: {
						"application/json": {
							schema: JSON.parse(JSON.stringify(z.toJSONSchema(resetPasswordBodySchema))),
						},
					},
				};
			operation.security = [{ serviceToken: [] }];
			operation.parameters = [
				{ in: "header", name: "Origin", required: true, schema: { type: "string" } },
				...(operation.parameters ?? []),
				{ in: "header", name: "X-CSRF-Token", required: true, schema: { type: "string" } },
				{ in: "header", name: "Idempotency-Key", required: true, schema: { type: "string" } },
			];
			// Quotum deliberately returns a non-enumerating acknowledgement for these endpoints.
			if (
				["/sign-up/email", "/request-password-reset", "/send-verification-email"].includes(suffix)
			)
				operation.responses = {
					...operation.responses,
					200: {
						description: "Non-enumerating acknowledgement",
						content: {
							"application/json": {
								schema: {
									type: "object",
									required: ["status"],
									properties: { status: { const: true } },
								},
							},
						},
					},
				};

			if (suffix === "/sign-in/email") {
				// The configured two-factor plugin intercepts successful password sign-in.
				operation.responses = {
					...operation.responses,
					200: {
						description: "Continue with email OTP",
						content: {
							"application/json": {
								schema: {
									type: "object",
									required: ["twoFactorRedirect"],
									properties: {
										twoFactorRedirect: { const: true },
										twoFactorMethods: { type: "array", items: { type: "string" } },
									},
								},
							},
						},
					},
				};
			}
			for (const status of [400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 500, 503]) {
				const previous = operation.responses?.[status];
				const content =
					previous && "content" in previous
						? previous.content?.["application/json"]?.schema
						: undefined;
				operation.responses = {
					...operation.responses,
					[status]: {
						description: "Authentication or Quotum boundary error",
						content: {
							"application/json": {
								schema: content
									? { anyOf: [content, { $ref: "#/components/schemas/QuotumError" }] }
									: { $ref: "#/components/schemas/QuotumError" },
							},
						},
					},
				};
			}
			paths[`/api/auth${suffix}`] = { post: operation };
		}
	}
	paths["/api/auth/callback/google"] = {
		get: {
			operationId: "authCallbackGoogle",
			tags: ["authentication"],
			security: [{ serviceToken: [] }],
			parameters: [
				{ in: "query", name: "code", schema: { type: "string" } },
				{ in: "query", name: "state", schema: { type: "string" } },
				{ in: "query", name: "error", schema: { type: "string" } },
			],
			responses: {
				302: {
					description: "OAuth completion redirect",
					headers: { Location: { schema: { type: "string" } } },
				},
				default: { description: "OAuth failure" },
			},
		},
	};
	// The app recursively removes these fields from auth JSON. Reflect that boundary in every schema.
	const privateFields = new Set([
		"token",
		"accessToken",
		"refreshToken",
		"idToken",
		"password",
		"secret",
		"backupCodes",
	]);
	function redact(value: unknown): void {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) redact(item);
			return;
		}
		const node = value as Record<string, unknown>;
		if (node.properties && typeof node.properties === "object")
			for (const field of privateFields) delete (node.properties as Record<string, unknown>)[field];
		if (Array.isArray(node.required))
			node.required = node.required.filter((x) => typeof x !== "string" || !privateFields.has(x));
		for (const child of Object.values(node)) redact(child);
	}
	// Do not redact request schemas: passwords and verification tokens remain valid inputs.
	for (const item of Object.values(paths)) if (item?.post) redact(item.post.responses);
	// Better Auth's shared User/Session response components may contain credential fields.
	redact(doc.components?.schemas);

	// Better Auth emits some OpenAPI 3.0 nullable fields. Normalize them to 3.1 JSON Schema.
	function normalize(value: unknown): void {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) normalize(item);
			return;
		}
		const node = value as Record<string, unknown>;
		if (node.nullable === true) {
			delete node.nullable;
			if (typeof node.type === "string") node.type = [node.type, "null"];
		}
		for (const child of Object.values(node)) normalize(child);
	}
	normalize(paths);
	normalize(doc.components);
	return { ...doc, paths };
}
