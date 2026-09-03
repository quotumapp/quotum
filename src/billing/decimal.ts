import { InvalidRequestError } from "./errors";

const unsignedDecimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function canonicalDecimal(value: string, field: string, maxScale = 9): string {
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

export function positiveDecimal(value: string, field: string, maxScale = 9): string {
	const canonical = canonicalDecimal(value, field, maxScale);
	if (decimalToUnits(canonical, maxScale) <= 0n) {
		throw new InvalidRequestError(`${field} must be greater than zero`);
	}
	return canonical;
}

export function decimalToUnits(value: string, scale: number): bigint {
	const canonical = canonicalDecimal(value, "decimal", scale);
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
		return canonicalDecimal(value, field, maxScale);
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

export function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}

	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
		.join(",")}}`;
}
