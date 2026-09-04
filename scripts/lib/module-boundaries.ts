import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import {
	isCallExpression,
	isElementAccessExpression,
	isExportDeclaration,
	isExternalModuleReference,
	isIdentifier,
	isImportDeclaration,
	isImportEqualsDeclaration,
	isImportTypeNode,
	isLiteralTypeNode,
	isNamedExports,
	isNamedImports,
	isNamespaceImport,
	isObjectBindingPattern,
	isPropertyAccessExpression,
	isQualifiedName,
	isStringLiteralLikeNode,
	isVariableDeclaration,
	type Node,
	type SourceFile,
	SyntaxKind,
} from "typescript/unstable/ast";
import { API, type Project } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";

export const platformTablePrefix = "platform_";

export const moduleOwners = [
	"billing",
	"platform",
	"shared",
	"composition",
	"test_support",
] as const;

export type ModuleOwner = (typeof moduleOwners)[number];

export interface BoundarySourceFile {
	path: string;
	source: string;
}

export interface ModuleBoundaryRule {
	owner: ModuleOwner;
	description: string;
	matches(path: string): boolean;
}

export type BoundaryViolationCode =
	| "AMBIGUOUS_OWNER"
	| "CONTRACT_PERSISTENCE_LEAK"
	| "FORBIDDEN_DEPENDENCY"
	| "FORBIDDEN_PERSISTENCE_ACCESS"
	| "NON_LITERAL_MODULE_REFERENCE"
	| "UNCLASSIFIED_FILE"
	| "UNRESOLVED_INTERNAL_IMPORT";

export interface BoundaryViolation {
	code: BoundaryViolationCode;
	path: string;
	line: number;
	message: string;
}

export interface AnalyzeModuleBoundaryOptions {
	compilerOptions?: Readonly<Record<string, unknown>>;
	packageJson?: Readonly<Record<string, unknown>>;
	rules?: readonly ModuleBoundaryRule[];
}

const compositionPaths = new Set([
	"src/app.ts",
	"src/index.ts",
	"src/migrate.ts",
	"src/runtime.ts",
	"src/shutdown.ts",
]);

const billingPaths = new Set([
	"scripts/billing-catalog.ts",
	"scripts/provision-catalog.ts",
	"src/env.ts",
]);

const billingPrefixes = [
	"src/admin/",
	"src/app/",
	"src/billing/",
	"src/catalog/",
	"src/db/",
	"src/http/",
	"src/observability/",
	"src/operations/",
	"src/projects/",
	"src/projections/",
	"src/providers/",
	"src/sdk/",
	"src/workers/",
] as const;

const testSupportPaths = new Set([
	"scripts/check-module-boundaries.ts",
	"scripts/projection-receiver.ts",
	"scripts/test-e2e.ts",
	"scripts/test-integration.ts",
	"scripts/test-migration-integrity.ts",
]);

const testSupportPrefixes = ["scripts/lib/", "src/testing/", "tests/"] as const;

export const defaultModuleBoundaryRules: readonly ModuleBoundaryRule[] = [
	{
		owner: "billing",
		description: "billing runtime and operational tooling",
		matches: (path) => billingPaths.has(path) || hasPrefix(path, billingPrefixes),
	},
	{
		owner: "platform",
		description: "platform module",
		matches: (path) => path.startsWith("src/platform/"),
	},
	{
		owner: "shared",
		description: "module-neutral shared code",
		matches: (path) => path.startsWith("src/shared/"),
	},
	{
		owner: "composition",
		description: "application composition and lifecycle entrypoints",
		matches: (path) => compositionPaths.has(path),
	},
	{
		owner: "test_support",
		description: "tests and test-only tooling",
		matches: (path) => testSupportPaths.has(path) || hasPrefix(path, testSupportPrefixes),
	},
];

const allowedInternalDependencies: Readonly<Record<ModuleOwner, ReadonlySet<ModuleOwner>>> = {
	billing: new Set(["billing", "shared"]),
	platform: new Set(["platform", "shared"]),
	shared: new Set(["shared"]),
	composition: new Set(["billing", "platform", "shared", "composition"]),
	test_support: new Set(moduleOwners),
};

const restrictedPersistencePackages = ["drizzle-orm", "pg", "postgres"] as const;
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"] as const;
const ignoredSourceDirectories = new Set([
	".bun",
	".cache",
	".git",
	"coverage",
	"dist",
	"node_modules",
]);
const allowedNonLiteralModuleReferencePaths = new Set(["scripts/billing-catalog.ts"]);
const selfPackageName = "quotum-api";

export async function readBoundarySourceFiles(root: string): Promise<BoundarySourceFile[]> {
	const paths = await collectTypeScriptPaths(root);
	return await Promise.all(
		paths.map(async (path) => ({
			path,
			source: await readFile(join(root, ...path.split("/")), "utf8"),
		})),
	);
}

export async function readBoundaryAnalysisOptions(
	root: string,
): Promise<AnalyzeModuleBoundaryOptions> {
	const [tsconfigSource, packageJsonSource] = await Promise.all([
		readFile(join(root, "tsconfig.json"), "utf8"),
		readFile(join(root, "package.json"), "utf8"),
	]);
	const tsconfig = Bun.JSONC.parse(tsconfigSource) as {
		compilerOptions?: Record<string, unknown>;
		extends?: unknown;
	};
	if (tsconfig.extends !== undefined) {
		throw new Error(
			"The module-boundary checker must be updated to resolve tsconfig extends before one is added",
		);
	}

	return {
		compilerOptions: tsconfig.compilerOptions ?? {},
		packageJson: Bun.JSONC.parse(packageJsonSource) as Record<string, unknown>,
	};
}

export async function analyzeModuleBoundaries(
	inputFiles: readonly BoundarySourceFile[],
	options: AnalyzeModuleBoundaryOptions = {},
): Promise<BoundaryViolation[]> {
	const rules = options.rules ?? defaultModuleBoundaryRules;
	const files = new Map(inputFiles.map((file) => [normalizeRepoPath(file.path), file] as const));
	const owners = new Map<string, ModuleOwner>();
	const violations: BoundaryViolation[] = [];

	for (const path of files.keys()) {
		const matches = rules.filter((rule) => rule.matches(path));
		if (matches.length === 0) {
			violations.push({
				code: "UNCLASSIFIED_FILE",
				path,
				line: 1,
				message: `${path} is not assigned to a module owner`,
			});
			continue;
		}
		if (matches.length > 1) {
			violations.push({
				code: "AMBIGUOUS_OWNER",
				path,
				line: 1,
				message: `${path} matches multiple module owners: ${matches
					.map((match) => match.owner)
					.join(", ")}`,
			});
			continue;
		}
		owners.set(path, matches[0].owner);
	}

	const virtualRoot = "/__quotum_module_boundaries__";
	const configPath = `${virtualRoot}/tsconfig.json`;
	const virtualFiles: Record<string, string> = {
		[configPath]: JSON.stringify({
			compilerOptions: {
				jsx: "preserve",
				module: "esnext",
				moduleResolution: "bundler",
				target: "esnext",
				...options.compilerOptions,
				noEmit: true,
				noLib: true,
				types: [],
			},
			files: [...files.keys()],
		}),
		[`${virtualRoot}/package.json`]: JSON.stringify(
			options.packageJson ?? { exports: { "./sdk": "./src/sdk/index.ts" }, name: selfPackageName },
		),
	};
	for (const [path, file] of files) {
		virtualFiles[`${virtualRoot}/${path}`] = file.source;
	}

	const api = new API({ cwd: virtualRoot, fs: createVirtualFileSystem(virtualFiles) });
	try {
		const snapshot = await api.updateSnapshot({ openProjects: [configPath] });
		try {
			const project = snapshot.getProject(configPath);
			if (project === undefined) {
				throw new Error(`TypeScript did not create the boundary-analysis project ${configPath}`);
			}

			for (const path of files.keys()) {
				const owner = owners.get(path);
				if (owner === undefined) {
					continue;
				}

				const sourceFile = await project.program.getSourceFile(`${virtualRoot}/${path}`);
				if (sourceFile === undefined) {
					throw new Error(`TypeScript did not parse boundary-analysis source ${path}`);
				}
				const references = collectModuleReferences(sourceFile);

				if (owner === "platform" || owner === "shared") {
					for (const node of findBunSqlReferences(sourceFile)) {
						violations.push({
							code: "FORBIDDEN_PERSISTENCE_ACCESS",
							path,
							line: lineForNode(sourceFile, node),
							message: `${path} cannot use Bun SQL outside an owned persistence adapter`,
						});
					}
				}

				for (const reference of references) {
					if (reference.specifier === null) {
						if (owner !== "test_support" && !allowedNonLiteralModuleReferencePaths.has(path)) {
							violations.push({
								code: "NON_LITERAL_MODULE_REFERENCE",
								path,
								line: lineForNode(sourceFile, reference.node),
								message: `${path} uses a non-literal dynamic import or require that cannot be ownership-checked`,
							});
						}
						continue;
					}

					let targetPath = resolveInternalSpecifier(path, reference.specifier, files);
					const configuredResolution = resolveConfiguredInternalSpecifier(
						reference.specifier,
						files,
						options,
					);
					if (targetPath === null) {
						targetPath = await resolveCompilerInternalSpecifier(
							project,
							reference.node,
							virtualRoot,
							files,
						);
					}
					targetPath ??= configuredResolution.path;
					if (
						isInternalSpecifier(reference.specifier) ||
						configuredResolution.matched ||
						targetPath !== null
					) {
						if (targetPath === null) {
							violations.push({
								code: "UNRESOLVED_INTERNAL_IMPORT",
								path,
								line: lineForNode(sourceFile, reference.node),
								message: `${path} imports unresolved internal path ${JSON.stringify(reference.specifier)}`,
							});
							continue;
						}

						const targetOwner = owners.get(targetPath);
						if (targetOwner === undefined) {
							continue;
						}

						if (isPersistenceFreeContract(path) && targetPath.startsWith("src/db/")) {
							violations.push({
								code: "CONTRACT_PERSISTENCE_LEAK",
								path,
								line: lineForNode(sourceFile, reference.node),
								message: `${path} cannot expose types from billing persistence ${targetPath}`,
							});
							continue;
						}

						if ((owner === "platform" || owner === "shared") && targetPath.startsWith("src/db/")) {
							violations.push({
								code: "FORBIDDEN_PERSISTENCE_ACCESS",
								path,
								line: lineForNode(sourceFile, reference.node),
								message: `${path} cannot import billing persistence ${targetPath}`,
							});
							continue;
						}

						if (!allowedInternalDependencies[owner].has(targetOwner)) {
							violations.push({
								code: "FORBIDDEN_DEPENDENCY",
								path,
								line: lineForNode(sourceFile, reference.node),
								message: `${owner} file ${path} cannot depend on ${targetOwner} file ${targetPath}`,
							});
						}
						continue;
					}

					if (
						(owner === "platform" || owner === "shared") &&
						isRestrictedPersistencePackage(reference.specifier)
					) {
						violations.push({
							code: "FORBIDDEN_PERSISTENCE_ACCESS",
							path,
							line: lineForNode(sourceFile, reference.node),
							message: `${path} cannot import persistence package ${JSON.stringify(reference.specifier)}`,
						});
					}
				}
			}
		} finally {
			await snapshot.dispose();
		}
	} finally {
		await api.close();
	}

	return violations.sort(
		(left, right) =>
			left.path.localeCompare(right.path) ||
			left.line - right.line ||
			left.code.localeCompare(right.code) ||
			left.message.localeCompare(right.message),
	);
}

export function formatBoundaryViolation(violation: BoundaryViolation): string {
	return `${violation.path}:${violation.line} [${violation.code}] ${violation.message}`;
}

interface ModuleReference {
	specifier: string | null;
	node: Node;
}

function collectModuleReferences(sourceFile: SourceFile): ModuleReference[] {
	const references: ModuleReference[] = [];
	const visit = (node: Node) => {
		if (isImportDeclaration(node) || isExportDeclaration(node)) {
			if (node.moduleSpecifier !== undefined && isStringLiteralLikeNode(node.moduleSpecifier)) {
				references.push({ specifier: node.moduleSpecifier.text, node: node.moduleSpecifier });
			}
		} else if (
			isImportEqualsDeclaration(node) &&
			isExternalModuleReference(node.moduleReference) &&
			node.moduleReference.expression !== undefined &&
			isStringLiteralLikeNode(node.moduleReference.expression)
		) {
			references.push({
				specifier: node.moduleReference.expression.text,
				node: node.moduleReference.expression,
			});
		} else if (isImportTypeNode(node)) {
			const argument = node.argument;
			if (isLiteralTypeNode(argument) && isStringLiteralLikeNode(argument.literal)) {
				references.push({ specifier: argument.literal.text, node: argument.literal });
			}
		} else if (isCallExpression(node) && isModuleLoaderExpression(node.expression)) {
			const [argument] = node.arguments;
			references.push({
				specifier:
					argument !== undefined && isStringLiteralLikeNode(argument) ? argument.text : null,
				node: argument ?? node,
			});
		}
		node.forEachChild(visit);
	};
	visit(sourceFile);
	return references;
}

function findBunSqlReferences(sourceFile: SourceFile): Node[] {
	const references: Node[] = [];
	const bunNamespaceBindings = new Set<string>();

	for (const statement of sourceFile.statements) {
		if (
			isImportDeclaration(statement) &&
			isStringLiteralLikeNode(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text === "bun"
		) {
			const defaultBinding = statement.importClause?.name;
			if (defaultBinding !== undefined) {
				bunNamespaceBindings.add(defaultBinding.text);
			}
			const bindings = statement.importClause?.namedBindings;
			if (bindings !== undefined && isNamespaceImport(bindings)) {
				bunNamespaceBindings.add(bindings.name.text);
			}
			if (bindings !== undefined && isNamedImports(bindings)) {
				for (const element of bindings.elements) {
					const importedName = element.propertyName?.text ?? element.name.text;
					if (importedName === "SQL" || importedName === "sql") {
						references.push(element);
					}
				}
			}
		} else if (
			isImportEqualsDeclaration(statement) &&
			isExternalModuleReference(statement.moduleReference) &&
			statement.moduleReference.expression !== undefined &&
			isStringLiteralLikeNode(statement.moduleReference.expression) &&
			statement.moduleReference.expression.text === "bun"
		) {
			bunNamespaceBindings.add(statement.name.text);
		} else if (
			isExportDeclaration(statement) &&
			statement.moduleSpecifier !== undefined &&
			isStringLiteralLikeNode(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text === "bun"
		) {
			if (statement.exportClause === undefined) {
				references.push(statement);
			} else if (isNamedExports(statement.exportClause)) {
				for (const element of statement.exportClause.elements) {
					const exportedName = element.propertyName?.text ?? element.name.text;
					if (exportedName === "SQL" || exportedName === "sql") {
						references.push(element);
					}
				}
			}
		}
	}

	const visit = (node: Node) => {
		if (
			isPropertyAccessExpression(node) &&
			(node.name.text === "SQL" || node.name.text === "sql") &&
			isIdentifier(node.expression) &&
			isBunNamespaceName(node.expression.text, bunNamespaceBindings)
		) {
			references.push(node);
		} else if (
			isQualifiedName(node) &&
			(node.right.text === "SQL" || node.right.text === "sql") &&
			isIdentifier(node.left) &&
			isBunNamespaceName(node.left.text, bunNamespaceBindings)
		) {
			references.push(node);
		} else if (
			isElementAccessExpression(node) &&
			isIdentifier(node.expression) &&
			isBunNamespaceName(node.expression.text, bunNamespaceBindings) &&
			isStringLiteralLikeNode(node.argumentExpression) &&
			(node.argumentExpression.text === "SQL" || node.argumentExpression.text === "sql")
		) {
			references.push(node);
		} else if (
			isImportTypeNode(node) &&
			isLiteralTypeNode(node.argument) &&
			isStringLiteralLikeNode(node.argument.literal) &&
			node.argument.literal.text === "bun" &&
			node.qualifier !== undefined &&
			isIdentifier(node.qualifier) &&
			(node.qualifier.text === "SQL" || node.qualifier.text === "sql")
		) {
			references.push(node);
		} else if (
			isVariableDeclaration(node) &&
			isObjectBindingPattern(node.name) &&
			node.initializer !== undefined &&
			isIdentifier(node.initializer) &&
			isBunNamespaceName(node.initializer.text, bunNamespaceBindings)
		) {
			for (const element of node.name.elements) {
				const importedName =
					element.propertyName?.getText(sourceFile) ?? element.name?.getText(sourceFile);
				if (importedName === "SQL" || importedName === "sql") {
					references.push(element);
				}
			}
		} else if (
			isCallExpression(node) &&
			isModuleLoaderExpression(node.expression) &&
			node.arguments[0] !== undefined &&
			isStringLiteralLikeNode(node.arguments[0]) &&
			node.arguments[0].text === "bun"
		) {
			// Dynamic imports and require calls cannot prove which Bun export is consumed.
			// Deny them in platform code so they cannot bypass the explicit SQL checks above.
			references.push(node);
		}
		node.forEachChild(visit);
	};
	visit(sourceFile);
	return references;
}

async function resolveCompilerInternalSpecifier(
	project: Project,
	referenceNode: Node,
	virtualRoot: string,
	files: ReadonlyMap<string, BoundarySourceFile>,
): Promise<string | null> {
	const symbol = await project.checker.getSymbolAtLocation(referenceNode);
	if (symbol === undefined) {
		return null;
	}

	const virtualPrefix = `${virtualRoot}/`;
	for (const declaration of symbol.declarations) {
		const declarationPath = String(declaration.path);
		if (!declarationPath.startsWith(virtualPrefix)) {
			continue;
		}
		const repositoryPath = normalizeRepoPath(declarationPath.slice(virtualPrefix.length));
		if (files.has(repositoryPath)) {
			return repositoryPath;
		}
	}

	return null;
}

function resolveInternalSpecifier(
	importerPath: string,
	specifier: string,
	files: ReadonlyMap<string, BoundarySourceFile>,
): string | null {
	if (specifier === `${selfPackageName}/sdk`) {
		return files.has("src/sdk/index.ts") ? "src/sdk/index.ts" : null;
	}
	if (!specifier.startsWith(".")) {
		return null;
	}

	const base = posix.normalize(posix.join(posix.dirname(importerPath), specifier));
	return resolveSourcePath(base, files);
}

interface ConfiguredInternalResolution {
	matched: boolean;
	path: string | null;
}

function resolveConfiguredInternalSpecifier(
	specifier: string,
	files: ReadonlyMap<string, BoundarySourceFile>,
	options: AnalyzeModuleBoundaryOptions,
): ConfiguredInternalResolution {
	const paths = options.compilerOptions?.paths;
	if (isUnknownRecord(paths)) {
		const entries = Object.entries(paths).sort(
			([left], [right]) => aliasPatternSpecificity(right) - aliasPatternSpecificity(left),
		);
		for (const [pattern, rawTargets] of entries) {
			const wildcard = matchAliasPattern(pattern, specifier);
			if (wildcard === null || !Array.isArray(rawTargets)) {
				continue;
			}
			const baseUrl =
				typeof options.compilerOptions?.baseUrl === "string"
					? options.compilerOptions.baseUrl
					: ".";
			for (const rawTarget of rawTargets) {
				if (typeof rawTarget !== "string") {
					continue;
				}
				const substituted = rawTarget.replace("*", wildcard);
				const path = resolveSourcePath(posix.normalize(posix.join(baseUrl, substituted)), files);
				if (path !== null) {
					return { matched: true, path };
				}
			}
			return { matched: true, path: null };
		}
	}

	const packageImports = options.packageJson?.imports;
	if (isUnknownRecord(packageImports)) {
		const entries = Object.entries(packageImports).sort(
			([left], [right]) => aliasPatternSpecificity(right) - aliasPatternSpecificity(left),
		);
		for (const [pattern, rawTarget] of entries) {
			const wildcard = matchAliasPattern(pattern, specifier);
			if (wildcard === null) {
				continue;
			}
			for (const target of collectPackageImportTargets(rawTarget)) {
				if (!target.startsWith("./")) {
					continue;
				}
				const substituted = target.replace("*", wildcard);
				const path = resolveSourcePath(posix.normalize(substituted.slice(2)), files);
				if (path !== null) {
					return { matched: true, path };
				}
			}
			return { matched: true, path: null };
		}
	}

	const baseUrl = options.compilerOptions?.baseUrl;
	if (typeof baseUrl === "string" && !isInternalSpecifier(specifier)) {
		const path = resolveSourcePath(posix.normalize(posix.join(baseUrl, specifier)), files);
		if (path !== null) {
			return { matched: true, path };
		}
	}

	return { matched: false, path: null };
}

function resolveSourcePath(
	base: string,
	files: ReadonlyMap<string, BoundarySourceFile>,
): string | null {
	const candidates = hasSourceExtension(base)
		? [base]
		: [
				base,
				...sourceExtensions.map((extension) => `${base}${extension}`),
				...sourceExtensions.map((extension) => `${base}/index${extension}`),
			];
	for (const candidate of candidates) {
		if (files.has(candidate)) {
			return candidate;
		}
	}
	return null;
}

function matchAliasPattern(pattern: string, specifier: string): string | null {
	const wildcardIndex = pattern.indexOf("*");
	if (wildcardIndex === -1) {
		return pattern === specifier ? "" : null;
	}
	const prefix = pattern.slice(0, wildcardIndex);
	const suffix = pattern.slice(wildcardIndex + 1);
	if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
		return null;
	}
	return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function aliasPatternSpecificity(pattern: string): number {
	return pattern.replace("*", "").length;
}

function collectPackageImportTargets(value: unknown): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(collectPackageImportTargets);
	}
	if (isUnknownRecord(value)) {
		return Object.values(value).flatMap(collectPackageImportTargets);
	}
	return [];
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInternalSpecifier(specifier: string): boolean {
	return (
		specifier.startsWith(".") ||
		specifier.startsWith("/") ||
		specifier.startsWith("#") ||
		specifier.startsWith("file:") ||
		specifier === selfPackageName ||
		specifier.startsWith(`${selfPackageName}/`)
	);
}

function isModuleLoaderExpression(node: Node): boolean {
	return node.kind === SyntaxKind.ImportKeyword || (isIdentifier(node) && node.text === "require");
}

function isBunNamespaceName(name: string, bindings: ReadonlySet<string>): boolean {
	return name === "Bun" || bindings.has(name);
}

function isRestrictedPersistencePackage(specifier: string): boolean {
	return restrictedPersistencePackages.some(
		(packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
	);
}

function isPersistenceFreeContract(path: string): boolean {
	return (
		path === "src/app/types.ts" ||
		/^src\/(?:billing|platform)\/application\/(?:.*\/)?contracts\.ts$/u.test(path)
	);
}

function hasPrefix(path: string, prefixes: readonly string[]): boolean {
	return prefixes.some((prefix) => path.startsWith(prefix));
}

function hasSourceExtension(path: string): boolean {
	return sourceExtensions.some((extension) => path.endsWith(extension));
}

function normalizeRepoPath(path: string): string {
	const normalized = path.split("\\").join("/");
	return posix.normalize(normalized.startsWith("./") ? normalized.slice(2) : normalized);
}

function lineForNode(sourceFile: SourceFile, node: Node): number {
	return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

async function collectTypeScriptPaths(root: string): Promise<string[]> {
	const paths: string[] = [];
	await walk(root, root, paths);
	return paths.sort((left, right) => left.localeCompare(right));
}

async function walk(directory: string, root: string, paths: string[]): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		const absolutePath = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (ignoredSourceDirectories.has(entry.name)) {
				continue;
			}
			await walk(absolutePath, root, paths);
			continue;
		}
		if (!entry.isFile() || !hasSourceExtension(entry.name)) {
			continue;
		}
		paths.push(relative(root, absolutePath).split(sep).join("/"));
	}
}
