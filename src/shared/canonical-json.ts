export function canonicalJson(value: unknown): string {
	if (value === undefined) {
		return "null";
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (value instanceof Date) {
		return JSON.stringify(value.toISOString());
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}

	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}
