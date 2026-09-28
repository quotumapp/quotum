import {
	type Cadence,
	type CadenceUnit,
	cadenceFitsWithin,
	describeCadence,
	isCadenceUnit,
	maxCadenceCount,
} from "../shared/cadence";
import { InvalidRequestError } from "./errors";

/** Units the API does not accept yet; `hour` waits for its hot-path measurement. */
const unpublishedCadenceUnits: ReadonlySet<CadenceUnit> = new Set(["hour"]);

/** The longest reset or control window: three years, the longest billing interval sold. */
export const maxWindowSpan: Cadence = { unit: "year", count: 3 };

/**
 * Rejects a cadence the API does not accept: an unknown or unpublished unit, a count that is not a
 * whole number from 1 to 1000, or a span longer than `maxSpan`.
 */
export function assertCadence(cadence: Cadence, label: string, maxSpan = maxWindowSpan): void {
	if (!isCadenceUnit(cadence.unit)) {
		throw new InvalidRequestError(`${label} has an unknown interval`);
	}
	if (unpublishedCadenceUnits.has(cadence.unit)) {
		throw new InvalidRequestError(`${label} cannot use ${cadence.unit} yet`);
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
	assertCadence(cadence, label);
	return cadence;
}
