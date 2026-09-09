import { BillingError } from "../billing/errors";

export function requireNonBlank(value: string, name: string): string {
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new BillingError(`${name} must not be blank`, "INVALID_REQUEST", 400);
	}

	return trimmed;
}
