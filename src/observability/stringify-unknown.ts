export function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (value === null || value === undefined) {
		return String(value);
	}

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
