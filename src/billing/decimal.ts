import { InvalidRequestError } from "./errors";

const unsignedDecimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
/**
 * Digits a caller's decimal may carry before the point: the smallest numeric column,
 * NUMERIC(28, 9), holds 19. A larger value would reach SQL and fail there as a 500.
 */
const maxInputIntegerDigits = 19;

/** A caller's non-negative decimal in canonical form, bounded to what every column can hold. */
export function canonicalDecimal(value: string, field: string, maxScale = 9): string {
	const canonical = unboundedDecimal(value, field, maxScale);
	if ((canonical.split(".")[0] ?? "").length > maxInputIntegerDigits) {
		throw new InvalidRequestError(
			`${field} supports at most ${maxInputIntegerDigits} digits before the decimal point`,
		);
	}
	return canonical;
}

/** Canonical form without the input bound, for stored values and internal arithmetic. */
function unboundedDecimal(value: string, field: string, maxScale: number): string {
	const trimmed = value.trim();
	if (!unsignedDecimalPattern.test(trimmed)) {
		throw new InvalidRequestError(`${field} must be a non-negative decimal string`);
	}

	const [whole = "0", fraction = ""] = trimmed.split(".");
	const canonicalFraction = fraction.replace(/0+$/, "");
	if (canonicalFraction.length > maxScale) {
		throw new InvalidRequestError(`${field} supports at most ${maxScale} decimal places`);
	}
	return canonicalFraction === "" ? whole : `${whole}.${canonicalFraction}`;
}

/**
 * A canonical decimal that may carry a leading minus, for monetary deltas that can fall as well
 * as rise. Negative zero renders as "0".
 */
export function canonicalSignedDecimal(value: string, field: string, maxScale = 9): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith("-")) {
		return canonicalDecimal(trimmed, field, maxScale);
	}
	const magnitude = canonicalDecimal(trimmed.slice(1), field, maxScale);
	return magnitude === "0" ? magnitude : `-${magnitude}`;
}

export function positiveDecimal(value: string, field: string, maxScale = 9): string {
	const canonical = canonicalDecimal(value, field, maxScale);
	if (decimalToUnits(canonical, maxScale) <= 0n) {
		throw new InvalidRequestError(`${field} must be greater than zero`);
	}
	return canonical;
}

export function decimalToUnits(value: string, scale: number): bigint {
	const canonical = unboundedDecimal(value, "decimal", scale);
	const [whole = "0", fraction = ""] = canonical.split(".");
	return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0");
}

export function unitsToDecimal(value: bigint, scale: number): string {
	const negative = value < 0n;
	const absolute = negative ? -value : value;
	if (scale === 0) {
		return `${negative ? "-" : ""}${absolute}`;
	}

	const divisor = 10n ** BigInt(scale);
	const whole = absolute / divisor;
	const fraction = (absolute % divisor).toString().padStart(scale, "0").replace(/0+$/, "");
	const rendered = fraction === "" ? whole.toString() : `${whole}.${fraction}`;
	return negative ? `-${rendered}` : rendered;
}

export function databaseDecimal(value: unknown, field: string, maxScale = 9): string {
	if (typeof value === "string") {
		return unboundedDecimal(value, field, maxScale);
	}
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
		return String(value);
	}
	throw new Error(`Invalid database decimal for ${field}`);
}

export function sha256Hex(value: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return hasher.digest("hex");
}

/**
 * Deterministic JSON for hashing: object keys are ordered with `localeCompare`, and keys that
 * compare equal (canonically equivalent Unicode such as U+00E9 and U+0065 U+0301) fall back to code
 * unit order, so the result never depends on insertion order. Objects without such a tie serialize
 * exactly as before, which keeps every persisted hash valid.
 */
export function stableJson(value: unknown): string {
	return serializeStable(value, true);
}

/**
 * The serialization used before tied keys were ordered: they kept their insertion order. Only
 * the replay of a usage operation stored by an earlier release needs it.
 */
export function legacyStableJson(value: unknown): string {
	return serializeStable(value, false);
}

function serializeStable(value: unknown, breakTies: boolean): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => serializeStable(item, breakTies)).join(",")}]`;
	}

	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => {
			const order = left.localeCompare(right);
			if (order !== 0 || !breakTies) return order;
			return left < right ? -1 : 1;
		})
		.map(([key, child]) => `${JSON.stringify(key)}:${serializeStable(child, breakTies)}`)
		.join(",")}}`;
}

export function signedDecimalToUnits(value: string, scale: number): bigint {
	return value.startsWith("-")
		? -decimalToUnits(value.slice(1), scale)
		: decimalToUnits(value, scale);
}
