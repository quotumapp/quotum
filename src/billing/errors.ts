import type { CatalogProviderCompatibility } from "../providers/catalog-compatibility-types";
import type { CapabilityLayer, RuntimeCapabilityVerdict } from "../shared/provider-capabilities";

export type BillingErrorClassification =
	| "invalid_request"
	| "unauthorized"
	| "not_configured"
	| "provider"
	| "not_found"
	| "persistence_conflict"
	| "internal";

export type BillingErrorDetails = Record<string, unknown>;

export interface BillingErrorOptions {
	classification?: BillingErrorClassification;
	exposeMessage?: boolean;
	details?: BillingErrorDetails;
}

export class BillingError extends Error {
	readonly classification: BillingErrorClassification;
	readonly exposeMessage: boolean;
	/** Absent, not undefined, when the error carries no details. */
	declare readonly details?: BillingErrorDetails;

	constructor(
		message: string,
		readonly code: string,
		readonly status = 400,
		options: BillingErrorOptions = {},
	) {
		super(message);
		this.name = new.target.name;
		this.classification = options.classification ?? classifyStatus(status);
		this.exposeMessage = options.exposeMessage ?? true;
		if (options.details !== undefined) {
			this.details = options.details;
		}
	}
}

export class InvalidRequestError extends BillingError {
	constructor(message: string, code = "INVALID_REQUEST") {
		super(message, code, 400, { classification: "invalid_request" });
	}
}

export class UnauthorizedBillingError extends BillingError {
	constructor(message: string, code = "UNAUTHORIZED", status = 401) {
		super(message, code, status, { classification: "unauthorized" });
	}
}

export class NotConfiguredError extends BillingError {
	constructor(
		message: string,
		code = "BILLING_PROVIDER_NOT_CONFIGURED",
		status = 501,
		details?: BillingErrorDetails,
	) {
		super(message, code, status, { classification: "not_configured", details });
	}
}

export class ProviderUnavailableError extends BillingError {
	constructor(message: string, code = "BILLING_PROVIDER_UNAVAILABLE", status = 503) {
		super(message, code, status, { classification: "provider" });
	}
}

export class PersistenceConflictError extends BillingError {
	constructor(message: string, code = "PERSISTENCE_CONFLICT", status = 409) {
		super(message, code, status, { classification: "persistence_conflict" });
	}
}

export class NotFoundBillingError extends BillingError {
	constructor(message: string, code = "NOT_FOUND") {
		super(message, code, 404, { classification: "not_found" });
	}
}

export class InternalBillingError extends BillingError {
	constructor(message: string, code = "INTERNAL_ERROR") {
		super(message, code, 500, { classification: "internal", exposeMessage: false });
	}
}

/**
 * Wire code, status and classification for a capability rejection, keyed by the verdict's blocking
 * layer. `PROVIDER_OPERATION_UNCERTAIN` stays reserved until a provider write can be uncertain.
 */
export const capabilityErrorCodes = {
	provider: {
		code: "PROVIDER_CAPABILITY_UNSUPPORTED",
		status: 400,
		classification: "invalid_request",
	},
	implementation: {
		code: "PROVIDER_CAPABILITY_UNSUPPORTED",
		status: 400,
		classification: "invalid_request",
	},
	configuration: {
		code: "PROVIDER_CAPABILITY_NOT_CONFIGURED",
		status: 409,
		classification: "not_configured",
	},
	operation: {
		code: "PROVIDER_ACTION_REQUIRED",
		status: 409,
		classification: "invalid_request",
	},
} as const satisfies Record<
	CapabilityLayer,
	{ code: string; status: number; classification: BillingErrorClassification }
>;

export type CapabilityErrorDetails =
	| { verdict: RuntimeCapabilityVerdict }
	| { providerCompatibility: CatalogProviderCompatibility[] };

/** A rejection decided by a provider capability declaration rather than by the provider. */
export class CapabilityError extends BillingError {
	declare readonly details: CapabilityErrorDetails;

	constructor(
		message: string,
		readonly blockingLayer: CapabilityLayer,
		details: CapabilityErrorDetails,
	) {
		const { code, status, classification } = capabilityErrorCodes[blockingLayer];
		super(message, code, status, { classification, exposeMessage: true, details });
	}
}

export interface ClassifiedBillingError {
	code: string;
	message: string;
	status: number;
	classification: BillingErrorClassification;
	details?: BillingErrorDetails;
}

export function isBillingError(value: unknown): value is BillingError {
	return value instanceof BillingError;
}

export function classifyBillingError(error: unknown): ClassifiedBillingError {
	if (isBillingError(error)) {
		return {
			code: error.code,
			message: error.exposeMessage ? error.message : "Billing request failed",
			status: error.status,
			classification: error.classification,
			...(error.details === undefined || !error.exposeMessage ? {} : { details: error.details }),
		};
	}

	return {
		code: "INTERNAL_ERROR",
		message: "Billing request failed",
		status: 500,
		classification: "internal",
	};
}

function classifyStatus(status: number): BillingErrorClassification {
	if (status === 401 || status === 403) {
		return "unauthorized";
	}
	if (status === 501 || status === 503) {
		return "not_configured";
	}
	if (status >= 500) {
		return "internal";
	}
	if (status === 404) {
		return "not_found";
	}
	if (status === 409) {
		return "persistence_conflict";
	}
	return "invalid_request";
}
