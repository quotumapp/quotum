import { resolve } from "node:path";
import {
	isNewExpression,
	isPropertyAssignment,
	isStringLiteralLikeNode,
	type Node,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";

/** Inventory literal wire codes at their runtime declarations, not copies in consumer repos. */
export async function generateErrorRegistry(root: string) {
	const api = new API({ cwd: root });
	const known = new Map<string, Set<string>>();
	try {
		const config = resolve(root, "tsconfig.json");
		const snapshot = await api.updateSnapshot({ openProjects: [config] });
		try {
			const project = snapshot.getProject(config);
			if (!project) throw new Error("Cannot load API source for the error registry");
			for await (const path of new Bun.Glob("src/**/*.ts").scan(root)) {
				if (
					path.includes("/testing/") ||
					path.includes("/contracts/") ||
					path.endsWith("-responses.ts")
				)
					continue;
				const source = await project.program.getSourceFile(resolve(root, path));
				if (!source) continue;
				function add(node: Node | undefined) {
					if (!node || !isStringLiteralLikeNode(node) || !/^[A-Z][A-Z0-9_]+$/.test(node.text))
						return;
					const locations = known.get(node.text) ?? new Set<string>();
					locations.add(path);
					known.set(node.text, locations);
				}
				function visit(node: Node) {
					if (isNewExpression(node)) {
						const name = node.expression.getText(source);
						if (name === "MerchantError") add(node.arguments?.[0]);
						else if (name.endsWith("Error")) add(node.arguments?.[1]);
					}
					if (isPropertyAssignment(node) && node.name.getText(source) === "code")
						add(node.initializer);
					// Default codes on the error class constructors are part of the same wire inventory.
					node.forEachChild(visit);
				}
				visit(source);
				// Constructor defaults have a tightly bounded lexical form; excludes comments and docs files.
				for (const match of source.text.matchAll(/\bcode\s*=\s*"([A-Z][A-Z0-9_]+)"/g)) {
					const code = match[1];
					if (code) {
						const locations = known.get(code) ?? new Set<string>();
						locations.add(path);
						known.set(code, locations);
					}
				}
			}
		} finally {
			await snapshot.dispose();
		}
	} finally {
		await api.close();
	}
	return {
		schemaVersion: 1,
		extensible: true,
		description:
			"Literal Quotum wire error codes. Native Better Auth/provider codes may also pass through; consumers must handle unknown codes. HTTP status and retry headers on the response remain authoritative.",
		codes: [...known]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([code, sources]) => ({ code, sources: [...sources].sort() })),
	};
}
