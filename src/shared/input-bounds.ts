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
