/**
 * Whether a `Content-Type` header names exactly `expected` (a lowercase `type/subtype`): the type
 * and subtype compare case-insensitively and any parameters, such as `charset`, are allowed.
 * A longer subtype (`application/jsonx`, `application/json-seq`) or a list of types does not match.
 */
export function hasMediaType(header: string | null, expected: string): boolean {
	if (header === null) return false;
	return header.split(";", 1)[0]?.trim().toLowerCase() === expected;
}
