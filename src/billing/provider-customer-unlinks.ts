import type { ProjectInstanceContext } from "../projects/context";
import type { AdjustmentList, AdjustmentListOptions } from "./balance-adjustments";
import { sha256Hex, stableJson } from "./decimal";
import { BillingError, InvalidRequestError } from "./errors";

export const providerCustomerUnlinkReasonMaxLength = 500;
export const providerCustomerIdMaxLength = 255;
/** A Stripe customer id, as Stripe issues it and as the test doubles spell theirs. */
export const stripeCustomerIdPattern = /^cus_[A-Za-z0-9_]+$/;

/**
 * Work in motion that reaches the provider through the link. An unlink is refused while any of it
 * exists, because the link decides which provider customer that work charges or answers for. An
 * auto top-up policy is not among them: it has no off switch an operator could use first, and a
 * top-up due while the account has no customer ends as one that needs action.
 */
export const providerCustomerUnlinkBlockerKinds = [
	"subscription",
	"provider_operation",
	"payment_setup",
	"auto_topup_job",
	"usage_invoice",
] as const;

export type ProviderCustomerUnlinkBlockerKind = (typeof providerCustomerUnlinkBlockerKinds)[number];

export interface ProviderCustomerUnlinkBlocker {
	kind: ProviderCustomerUnlinkBlockerKind;
	count: number;
}

export interface ProviderCustomerUnlinkInput {
	billingAccountId: string;
	provider: "stripe";
	/** The provider customer the caller means to unlink; another linked customer is refused. */
	externalCustomerId: string;
	reason: string;
	actor: string;
	idempotencyKey: string;
}

/** The receipt of one unlink. The link row is gone, so this is what remains of it. */
export interface ProviderCustomerUnlinkRecord {
	id: string;
	billingAccountId: string;
	provider: "stripe";
	externalCustomerId: string;
	providerAccountId: string | null;
	/** When the removed link was written. */
	linkedAt: string;
	actor: string;
	reason: string;
	createdAt: string;
}

export interface ProviderCustomerUnlinkMutationResult {
	duplicate: boolean;
	unlink: ProviderCustomerUnlinkRecord;
}

export interface ProviderCustomerUnlinkServiceLike {
	unlinkProviderCustomer(
		project: ProjectInstanceContext,
		input: ProviderCustomerUnlinkInput,
	): Promise<ProviderCustomerUnlinkMutationResult>;
	listProviderCustomerUnlinks(
		project: ProjectInstanceContext,
		billingAccountId: string,
		options: AdjustmentListOptions,
	): Promise<AdjustmentList<ProviderCustomerUnlinkRecord>>;
}

// Each entry declares `code` literally so the wire error registry inventories it.
const providerCustomerUnlinkErrorDefinitions = [
	{
		code: "PROVIDER_CUSTOMER_LINK_NOT_FOUND",
		status: 404,
		message: "Billing account has no provider customer link",
	},
	{
		code: "PROVIDER_CUSTOMER_LINK_MISMATCH",
		status: 409,
		message: "Billing account is linked to another provider customer",
	},
	{
		code: "PROVIDER_CUSTOMER_LINK_IN_USE",
		status: 409,
		message: "Provider customer link is still in use",
	},
] as const;

export type ProviderCustomerUnlinkErrorCode =
	(typeof providerCustomerUnlinkErrorDefinitions)[number]["code"];

export function providerCustomerUnlinkError(
	code: ProviderCustomerUnlinkErrorCode,
	details?: Record<string, unknown>,
): BillingError {
	const definition = providerCustomerUnlinkErrorDefinitions.find(
		(candidate) => candidate.code === code,
	);
	return new BillingError(
		definition?.message ?? "Provider customer unlink failed",
		code,
		definition?.status ?? 400,
		details === undefined ? {} : { details },
	);
}

/** Trims the text, so equal requests hash equally. */
export function normalizeProviderCustomerUnlinkInput(
	input: ProviderCustomerUnlinkInput,
): ProviderCustomerUnlinkInput {
	const externalCustomerId = input.externalCustomerId.trim();
	if (
		!stripeCustomerIdPattern.test(externalCustomerId) ||
		externalCustomerId.length > providerCustomerIdMaxLength
	) {
		throw new InvalidRequestError("externalCustomerId must be a Stripe customer id");
	}
	const reason = input.reason.trim();
	// Characters, as the reason column's `char_length` counts them, not UTF-16 units.
	if (reason === "" || [...reason].length > providerCustomerUnlinkReasonMaxLength) {
		throw new InvalidRequestError(
			`reason must contain between 1 and ${providerCustomerUnlinkReasonMaxLength} characters`,
		);
	}
	return { ...input, externalCustomerId, reason };
}

/** Identifies what an unlink asks for, so a reused idempotency key with other terms conflicts. */
export function providerCustomerUnlinkRequestHash(input: ProviderCustomerUnlinkInput): string {
	return sha256Hex(
		stableJson({
			provider: input.provider,
			externalCustomerId: input.externalCustomerId,
			reason: input.reason,
		}),
	);
}
