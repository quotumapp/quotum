export function renderDrizzleSql(query: unknown): string {
	if (!isRecord(query)) {
		return String(query);
	}

	if (typeof query.toQuery === "function") {
		try {
			const rendered = query.toQuery({
				escapeName: (name: string) => `"${name}"`,
				escapeParam: (index: number) => `$${index + 1}`,
				escapeString: (value: string) => `'${value.replaceAll("'", "''")}'`,
				casing: { getColumnCasing: (column: { name: string }) => column.name },
			});
			return `${rendered.sql}\n-- params: ${JSON.stringify(rendered.params)}`;
		} catch {
			// Fall back to rendering query chunks for SQL objects that do not support the test config.
		}
	}

	if (Array.isArray(query.queryChunks)) {
		return query.queryChunks.map(renderChunk).join("");
	}

	return String(query);
}

export function renderDrizzleSqlParams(query: unknown): unknown[] {
	if (!isRecord(query)) {
		throw new Error("Cannot render Drizzle SQL params");
	}

	if (typeof query.toQuery !== "function") {
		throw new Error("Cannot render Drizzle SQL params");
	}

	try {
		const rendered = query.toQuery({
			escapeName: (name: string) => `"${name}"`,
			escapeParam: (index: number) => `$${index + 1}`,
			escapeString: (value: string) => `'${value.replaceAll("'", "''")}'`,
			casing: { getColumnCasing: (column: { name: string }) => column.name },
		});
		return Array.isArray(rendered.params) ? rendered.params : [];
	} catch (cause) {
		throw new Error("Cannot render Drizzle SQL params", { cause });
	}
}

function renderChunk(chunk: unknown): string {
	if (!isRecord(chunk)) {
		return "?";
	}

	if (Array.isArray(chunk.value)) {
		return chunk.value.join("");
	}

	if (Array.isArray(chunk.queryChunks)) {
		return renderDrizzleSql(chunk);
	}

	return "?";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
