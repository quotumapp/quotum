import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { merchantBillingContracts } from "../../src/composition/merchant-openapi";
import { generateOpenApi, httpContracts } from "../../src/composition/openapi";
import { MERCHANT_AUTH_POST_PATHS, platformContracts } from "../../src/platform/app";
import { TeamViewSchema } from "../../src/platform/schemas";

test("exports each declared operation once, including delegated auth and billing", async () => {
	const document = await generateOpenApi("test");
	const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
		["get", "post", "put", "delete", "patch"].flatMap((method) =>
			item && method in item
				? [{ path, method, operation: (item as Record<string, { operationId: string }>)[method] }]
				: [],
		),
	);
	expect(operations.length).toBe(
		httpContracts.length +
			merchantBillingContracts(httpContracts).length +
			MERCHANT_AUTH_POST_PATHS.size +
			1,
	);
	expect(new Set(operations.map((x) => x.operation?.operationId)).size).toBe(operations.length);
	expect(document.paths?.["/openapi.json"]).toBeUndefined();
	expect(document.paths?.["/api/auth/reference"]).toBeUndefined();
	expect(document.paths?.["/api/billing/admin/reconciliation/subscriptions/run"]).toBeUndefined();
	const second = await generateOpenApi("test");
	expect(second).toEqual(document);
});
test("documents nullable onboarding and refuses a missing role policy", () => {
	expect(
		platformContracts.getApiPlatformOnboarding.input.responses[200]?.safeParse({
			success: true,
			data: null,
		}).success,
	).toBe(true);
	expect(
		TeamViewSchema.safeParse({
			organizationSlug: "acme",
			members: [],
			invitations: [],
			canManage: false,
		}).success,
	).toBe(false);
});
test("new literal routes must use the schema registration helper", async () => {
	for await (const path of new Bun.Glob("src/**/*.ts").scan(process.cwd())) {
		const source = await readFile(path, "utf8");
		expect(source.match(/\bapp\.(?:get|post|put|patch|delete)\s*\(/), path).toBeNull();
		const wildcardMounts = [...source.matchAll(/\bapp\.all\("([^"]+)"/g)].map((match) => match[1]);
		const expectedMounts: Record<string, string[]> = {
			"src/platform/app.ts": ["/api/auth/*", "/api/billing/*"],
			"src/composition/merchant-runtime.ts": ["/api/*", "*"],
		};
		expect(wildcardMounts, path).toEqual(expectedMounts[path] ?? []);
	}
});
