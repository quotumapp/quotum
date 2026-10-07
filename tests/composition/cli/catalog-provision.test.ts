import { describe, expect, it } from "bun:test";
import { assertDevelopmentCatalogImports } from "../../../src/composition/cli/catalog-provision";
import type { ProjectInstanceContextResolver } from "../../../src/projects/context";
import { projectInstanceContext } from "../../helpers/project-context";

function resolver(environment: "production" | "sandbox"): ProjectInstanceContextResolver {
	return {
		resolveInstanceKey: async () => ({
			kind: "resolved",
			context: { ...projectInstanceContext("acme"), environment },
		}),
		resolveInstanceId: async () => ({ kind: "not_found" }),
		resolveCredential: async () => ({ kind: "not_found" }),
	};
}
describe("development catalog command guard", () => {
	it("refuses production before starting the import transaction", async () => {
		await expect(
			assertDevelopmentCatalogImports(
				[{ projectInstanceKey: "acme", catalog: [] }],
				resolver("production"),
			),
		).rejects.toThrow("use quotum catalog bindings adopt");
	});
	it("allows sandbox imports", async () => {
		await expect(
			assertDevelopmentCatalogImports(
				[{ projectInstanceKey: "acme", catalog: [] }],
				resolver("sandbox"),
			),
		).resolves.toBeUndefined();
	});
});
