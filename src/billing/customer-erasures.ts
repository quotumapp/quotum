import type { ProjectInstanceContext } from "../projects/context";
import { type ErasureKey, erasureFingerprint } from "../shared/erasure-digest";
import { stableJson } from "./decimal";
import { BillingError, InvalidRequestError } from "./errors";

/** Why an operator erased the account. An enum, because free text can itself be personal data. */
export const customerErasureBases = [
	"data_subject_request",
	"merchant_offboarding",
	"legal_order",
	"other",
] as const;

export type CustomerErasureBasis = (typeof customerErasureBases)[number];

/** Losses an erasure causes that the operator must accept before it runs. */
export const customerErasureAcknowledgements = [
	"forfeit_paid_balances",
	"forfeit_lifetime_purchases",
] as const;

export type CustomerErasureAcknowledgement = (typeof customerErasureAcknowledgements)[number];

export const customerErasureStates = [
	"requested",
	"running",
	"verifying",
	"completed",
	"failed",
] as const;

export type CustomerErasureState = (typeof customerErasureStates)[number];

export const customerErasureReferenceMaxLength = 200;

/**
 * Work in motion that an erasure would strand: it still needs the account's identity, or it would
 * write to the account after the identity is gone. An erasure is refused while any of it exists.
 */
export const customerErasureBlockerKinds = [
	"subscription",
	"provider_operation",
	"payment_setup",
	"checkout",
	"commercial_action",
	"subscription_change",
	"catalog_migration",
	"paddle_checkout",
	"promotion_redemption",
	"usage_reservation",
	"auto_topup_job",
	"usage_invoice",
	"projection_delivery",
] as const;

export type CustomerErasureBlockerKind = (typeof customerErasureBlockerKinds)[number];

export interface CustomerErasureBlocker {
	kind: CustomerErasureBlockerKind;
	count: number;
}

/** What an erasure takes from the account that an operator must accept first. */
export interface CustomerErasureForfeits {
	/** Features with purchased, top-up or credit-grant quantity still unspent. */
	paidBalanceFeatures: number;
	/** Completed non-consumable purchases that still grant access. */
	lifetimePurchases: number;
}

export interface CustomerErasurePreview {
	/** Empty when the erasure can run. */
	blockers: CustomerErasureBlocker[];
	forfeits: CustomerErasureForfeits;
	/** The acknowledgements the request must carry for these forfeits. */
	requiredAcknowledgements: CustomerErasureAcknowledgement[];
	/** Rows the operation will delete or scrub, by table, as counted now. */
	rows: Record<string, number>;
}

export interface CustomerErasureInput {
	billingAccountId: string;
	basis: CustomerErasureBasis;
	reference: string | null;
	acknowledge: CustomerErasureAcknowledgement[];
	actor: string;
	idempotencyKey: string;
}

/**
 * The receipt of one erasure. It carries no billing account id: the id is the thing erased, so the
 * receipt is addressed by its own id.
 */
export interface CustomerErasureRecord {
	id: string;
	state: CustomerErasureState;
	basis: CustomerErasureBasis;
	reference: string | null;
	actor: string;
	acknowledged: CustomerErasureAcknowledgement[];
	/** The step the worker is on, or null once the operation has finished. */
	step: string | null;
	/** Rows deleted or scrubbed so far, by table. */
	counts: Record<string, number>;
	/** A stable code for the last failure; never a message that could carry data. */
	lastError: string | null;
	requestedAt: string;
	completedAt: string | null;
	/** When the tombstone stops blocking the id. */
	tombstoneExpiresAt: string;
}

export interface CustomerErasureMutationResult {
	duplicate: boolean;
	erasure: CustomerErasureRecord;
}

export interface CustomerErasureServiceLike {
	previewCustomerErasure(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<CustomerErasurePreview>;
	requestCustomerErasure(
		project: ProjectInstanceContext,
		input: CustomerErasureInput,
	): Promise<CustomerErasureMutationResult>;
	getCustomerErasure(
		project: ProjectInstanceContext,
		erasureId: string,
	): Promise<CustomerErasureRecord>;
}

// Each entry declares `code` literally so the wire error registry inventories it.
const customerErasureErrorDefinitions = [
	{
		code: "BILLING_ACCOUNT_ERASED",
		status: 409,
		message: "Billing account was erased and its id cannot be used again until the erasure expires",
	},
	{
		code: "CUSTOMER_ERASURE_BLOCKED",
		status: 409,
		message: "Billing account still has work in motion",
	},
	{
		code: "CUSTOMER_ERASURE_ACKNOWLEDGEMENT_REQUIRED",
		status: 409,
		message: "Erasure forfeits balances or purchases that were not acknowledged",
	},
	{
		code: "CUSTOMER_ERASURE_NOT_CONFIGURED",
		status: 501,
		message: "Customer erasure needs BILLING_ERASURE_KEY_ID and BILLING_ERASURE_KEY_BASE64",
	},
	{
		code: "CUSTOMER_ERASURE_NOT_FOUND",
		status: 404,
		message: "Customer erasure was not found",
	},
] as const;

export type CustomerErasureErrorCode = (typeof customerErasureErrorDefinitions)[number]["code"];

export function customerErasureError(
	code: CustomerErasureErrorCode,
	details?: Record<string, unknown>,
): BillingError {
	const definition = customerErasureErrorDefinitions.find((candidate) => candidate.code === code);
	return new BillingError(
		definition?.message ?? "Customer erasure failed",
		code,
		definition?.status ?? 409,
		details === undefined ? {} : { details },
	);
}

/** Trims the text and orders the acknowledgements, so equal requests hash equally. */
export function normalizeCustomerErasureInput(input: CustomerErasureInput): CustomerErasureInput {
	const billingAccountId = input.billingAccountId;
	if (
		billingAccountId.length === 0 ||
		billingAccountId.length > 200 ||
		billingAccountId !== billingAccountId.trim()
	) {
		throw new InvalidRequestError(
			"billingAccountId must contain 1–200 characters without surrounding whitespace",
		);
	}
	let reference: string | null = null;
	if (input.reference !== null) {
		reference = input.reference.trim();
		// Characters, as the column's `char_length` counts them, not UTF-16 units.
		if (reference === "" || [...reference].length > customerErasureReferenceMaxLength) {
			throw new InvalidRequestError(
				`reference must contain between 1 and ${customerErasureReferenceMaxLength} characters`,
			);
		}
	}
	return {
		...input,
		reference,
		acknowledge: [...new Set(input.acknowledge)].sort(),
	};
}

/**
 * Keyed, never a plain hash: the body contains the billing account id, so an unkeyed digest of it
 * would let a database reader test a guessed id against the receipt.
 */
export function customerErasureRequestHash(key: ErasureKey, input: CustomerErasureInput): string {
	return erasureFingerprint(
		key,
		stableJson({
			billingAccountId: input.billingAccountId,
			basis: input.basis,
			reference: input.reference,
			acknowledge: input.acknowledge,
		}),
	);
}
