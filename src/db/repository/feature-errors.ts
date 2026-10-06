import { InvalidRequestError } from "../../billing/errors";

/**
 * An active feature that is not metered was named where usage is counted. The feature exists, so
 * "not found" would send the caller looking for a mistyped key.
 */
export function featureNotMetered(key: string): InvalidRequestError {
	return new InvalidRequestError(
		`Feature ${key} is not metered: it has no balance and takes no usage`,
		"FEATURE_OPERATION_UNSUPPORTED",
	);
}
