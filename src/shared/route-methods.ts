/**
 * The methods registered for a path, for answering a known path's wrong method with 405 and
 * `Allow` instead of 404. HEAD is listed with GET because Elysia answers it for every GET route.
 * The patterns are compiled once per route table and rebuilt if routes are added later.
 */
export function routeMethodIndex(routes: () => ReadonlyArray<{ method: string; path: string }>) {
	let compiled: { count: number; patterns: Array<{ method: string; pattern: RegExp }> } | null =
		null;
	return {
		allowed(pathname: string): string[] {
			const current = routes();
			if (compiled?.count !== current.length) {
				compiled = {
					count: current.length,
					patterns: current
						.filter((route) => route.method !== "ALL")
						.map((route) => ({ method: route.method, pattern: routePattern(route.path) })),
				};
			}
			const methods = new Set(
				compiled.patterns
					.filter((route) => route.pattern.test(pathname))
					.map((route) => route.method),
			);
			if (methods.has("GET")) methods.add("HEAD");
			return [...methods].sort();
		},
	};
}

function routePattern(path: string): RegExp {
	const segments = path.split("/").map((segment) => {
		if (segment.startsWith(":")) return "[^/]+";
		if (segment === "*") return ".*";
		return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	});
	return new RegExp(`^${segments.join("/")}$`);
}
