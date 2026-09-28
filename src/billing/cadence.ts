import {
	type Cadence,
	type CadenceUnit,
	cadenceFitsWithin,
	describeCadence,
	isCadenceUnit,
	maxCadenceCount,
} from "../shared/cadence";
import { InvalidRequestError } from "./errors";

/** The longest reset or control window: three years, the longest billing interval sold. */
export const maxWindowSpan: Cadence = { unit: "year", count: 3 };

/**
 * What a cadence paces. A `window` is counted as requests arrive, so any unit works. A `grant` is
 * issued by the metering maintenance worker on its polling cadence, and a missed window is never
 * granted afterwards, so it cannot be hourly. `billing` intervals exclude `hour` by type.
 */
export type CadenceUse = "window" | "grant" | "billing";

/**
 * Rejects a cadence the API does not accept: an unknown unit, an hour where it cannot be honored,
 * a count that is not a whole number from 1 to 1000, or a span longer than `maxSpan`.
 */
export function assertCadence(
	cadence: Cadence,
	label: string,
	use: CadenceUse,
	maxSpan = maxWindowSpan,
): void {
	if (!isCadenceUnit(cadence.unit)) {
		throw new InvalidRequestError(`${label} has an unknown interval`);
	}
	if (cadence.unit === "hour" && use !== "window") {
		throw new InvalidRequestError(
			`${label} cannot be hourly: allocations are granted by periodic maintenance`,
		);
	}
	if (!Number.isInteger(cadence.count) || cadence.count < 1 || cadence.count > maxCadenceCount) {
		throw new InvalidRequestError(
			`${label} count must be a whole number from 1 to ${maxCadenceCount}`,
		);
	}
	if (!cadenceFitsWithin(cadence, maxSpan)) {
		throw new InvalidRequestError(`${label} cannot span more than ${describeCadence(maxSpan)}`);
	}
}

/**
 * The window cadence of a control or usage alert, or null for `lifetime`. A count is optional and
 * defaults to one; a lifetime window takes none.
 */
export function controlCadence(
	interval: CadenceUnit | "lifetime",
	intervalCount: number | null | undefined,
	label: string,
): Cadence | null {
	if (interval === "lifetime") {
		if (intervalCount !== undefined && intervalCount !== null) {
			throw new InvalidRequestError(`${label} with a lifetime interval takes no intervalCount`);
		}
		return null;
	}
	const cadence = { unit: interval, count: intervalCount ?? 1 };
	assertCadence(cadence, label, "window");
	return cadence;
}
