import { z } from "zod";

/**
 * Bounds on caller input that Postgres would otherwise refuse only at query time, which surfaced
 * as 500 INTERNAL_ERROR instead of 400 INVALID_REQUEST.
 */

/** The largest value of a Postgres `bigint`, the type of every numeric id. */
export const maxBigintId = 9_223_372_036_854_775_807n;

/** Digits only and within the signed 64-bit range a Postgres `bigint` id can hold. */
export function isBigintId(value: string): boolean {
	return /^\d{1,19}$/.test(value) && BigInt(value) <= maxBigintId;
}

/** Text Postgres can store: no NUL character and no unpaired UTF-16 surrogate. */
export function isStorableText(value: string): boolean {
	return !value.includes("\u0000") && value.isWellFormed();
}

/** A request URL whose path or query decodes to a NUL character, which Postgres cannot store. */
export function urlHasEncodedNul(url: string): boolean {
	return /%00/i.test(url);
}

/**
 * Whether a parsed JSON value holds a key or string Postgres cannot store. The walk is iterative,
 * so the depth of a body the size cap admits is no limit.
 */
export function hasUnstorableText(value: unknown): boolean {
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const next = pending.pop();
		if (typeof next === "string") {
			if (!isStorableText(next)) return true;
			continue;
		}
		if (typeof next !== "object" || next === null) continue;
		if (Array.isArray(next)) {
			for (const item of next) pending.push(item);
			continue;
		}
		for (const [key, child] of Object.entries(next)) {
			if (!isStorableText(key)) return true;
			pending.push(child);
		}
	}
	return false;
}

/** An instant a Postgres `timestamptz` round-trips: finite, with a year from 1 to 9999. */
export function isStorableInstant(date: Date): boolean {
	if (!Number.isFinite(date.getTime())) return false;
	const year = date.getUTCFullYear();
	return year >= 1 && year <= 9999;
}

/** An ISO 8601 date-time with an offset that a `timestamptz` column accepts. */
export function storableDateTimeSchema() {
	return z.iso
		.datetime({ offset: true })
		.refine((value) => isStorableInstant(new Date(value)), "Date must fall in years 1 to 9999");
}

/** A numeric id that fits a Postgres `bigint`. */
export function bigintIdSchema() {
	return z.string().regex(/^\d+$/).refine(isBigintId, "Id is out of range");
}

/**
 * A code point a display name must not carry: C0 and C1 controls (NUL, tab, CR and LF included),
 * the Unicode line and paragraph separators, and the bidirectional embedding, override and
 * isolate controls, which make a name read as different text.
 */
function isNameControl(codePoint: number): boolean {
	return (
		codePoint <= 0x1f ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		codePoint === 0x2028 ||
		codePoint === 0x2029 ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}

/** Storable text that people read as a name: no control or text-direction characters. */
export function isDisplayName(value: string): boolean {
	if (!isStorableText(value)) return false;
	for (const character of value) {
		if (isNameControl(character.codePointAt(0) ?? 0)) return false;
	}
	return true;
}

/** A trimmed display name of `min` to `max` UTF-16 code units. */
export function displayNameSchema(min: number, max: number) {
	return z
		.string()
		.trim()
		.min(min)
		.max(max)
		.refine(isDisplayName, "Names cannot contain control or text-direction characters");
}

/**
 * A display name built from text Quotum does not validate, such as an identity provider's
 * profile: controls become spaces, text-direction characters are dropped, runs of whitespace
 * collapse, and the result is trimmed and cut to `max` UTF-16 code units without splitting a
 * character.
 */
export function toDisplayName(value: string, max: number): string {
	let cleaned = "";
	for (const character of value.toWellFormed()) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (
			(codePoint >= 0x202a && codePoint <= 0x202e) ||
			(codePoint >= 0x2066 && codePoint <= 0x2069)
		)
			continue;
		cleaned += isNameControl(codePoint) ? " " : character;
	}
	let result = "";
	for (const character of cleaned.replace(/\s+/g, " ").trim()) {
		if (result.length + character.length > max) break;
		result += character;
	}
	return result.trimEnd();
}

/**
 * A query-string integer written in decimal digits. `z.coerce.number()` alone also reads `0x2`,
 * `1e1`, `2.0` and ` 2` as numbers; those now fail `schema` instead. The contract still renders
 * `schema` itself.
 */
export function decimalDigitsQuery<T extends z.ZodType>(schema: T) {
	return z.preprocess(
		(value) => (typeof value === "string" && !/^\d+$/.test(value) ? Number.NaN : value),
		schema,
	);
}
