import type { ProjectInstanceContext } from "../projects/context";
import { sha256Hex, stableJson } from "./decimal";
import { BillingError, InvalidRequestError } from "./errors";
import type { BillingProvider } from "./types";

/** How a plan grant stands; a trial is a plan grant whose origin is `trial`. */
export type PlanGrantStatus = "active" | "expired" | "ended" | "superseded";

export const trialDurationMaxDays = 730;
const trialMetadataMaxBytes = 4096;
const trialEndReasonMaxLength = 500;

export interface TrialRecord {
	id: string;
	billingAccountId: string;
	planKey: string;
	planVersion: number;
	/** `expired` as soon as the end has passed, even before the worker records it. */
	status: PlanGrantStatus;
	startsAt: string;
	endsAt: string;
	endedAt: string | null;
	durationDays: number;
	entitlementKeys: string[];
	supersededBy: { provider: BillingProvider; externalSubscriptionId: string } | null;
	endReason: string | null;
	actor: string;
	metadata: Record<string, unknown>;
	createdAt: string;
}

export interface TrialStartInput {
	billingAccountId: string;
	planKey: string;
	/** Absent means the plan version's own trial length. */
	durationDays: number | null;
	metadata: Record<string, unknown>;
	idempotencyKey: string;
	actor: string | null;
}

export interface TrialEndInput {
	billingAccountId: string;
	trialId: string;
	reason: string | null;
	idempotencyKey: string;
	actor: string | null;
}

export interface TrialMutationResult {
	duplicate: boolean;
	trial: TrialRecord;
}

export const trialIneligibilityReasons = [
	"TRIAL_PLAN_NOT_ELIGIBLE",
	"TRIAL_ALREADY_ACTIVE",
	"TRIAL_BASE_PLAN_ACTIVE",
	"TRIAL_ALREADY_USED",
] as const;
export type TrialIneligibility = (typeof trialIneligibilityReasons)[number];

export interface TrialEligibility {
	planKey: string;
	eligible: boolean;
	reason: TrialIneligibility | null;
	/** The published version's trial length, used when a start names no duration. */
	defaultDurationDays: number | null;
}

export interface TrialListResult {
	items: TrialRecord[];
	nextCursor: string | null;
}

export interface TrialServiceLike {
	startTrial(project: ProjectInstanceContext, input: TrialStartInput): Promise<TrialMutationResult>;
	endTrial(project: ProjectInstanceContext, input: TrialEndInput): Promise<TrialMutationResult>;
	listTrials(
		project: ProjectInstanceContext,
		billingAccountId: string,
		options: { limit: number; cursor: string | null },
	): Promise<TrialListResult>;
	getTrial(
		project: ProjectInstanceContext,
		billingAccountId: string,
		trialId: string,
	): Promise<TrialRecord>;
	trialEligibility(
		project: ProjectInstanceContext,
		billingAccountId: string,
		planKey: string,
	): Promise<TrialEligibility>;
}

// Each entry declares `code` literally so the wire error registry inventories it.
const trialErrorDefinitions = [
	{
		code: "TRIAL_PLAN_NOT_ELIGIBLE",
		status: 409,
		message:
			"Only a public base plan without licensed quantities or entity allocations can be trialed",
	},
	{
		code: "TRIAL_DURATION_REQUIRED",
		status: 400,
		message: "The plan declares no trial length, so the request must give durationDays",
	},
	{
		code: "TRIAL_ALREADY_USED",
		status: 409,
		message: "This billing account has already had a trial of this plan",
	},
	{
		code: "TRIAL_BASE_PLAN_ACTIVE",
		status: 409,
		message: "This billing account already has an active paid base plan",
	},
	{
		code: "TRIAL_ALREADY_ACTIVE",
		status: 409,
		message: "This billing account already has an active base plan trial",
	},
	{ code: "TRIAL_NOT_FOUND", status: 404, message: "Trial was not found" },
	{ code: "TRIAL_NOT_ACTIVE", status: 409, message: "Trial is no longer active" },
] as const;

export type TrialErrorCode = (typeof trialErrorDefinitions)[number]["code"];

export function trialError(
	code: TrialErrorCode,
	details?: Record<string, unknown>,
	message?: string,
): BillingError {
	const definition = trialErrorDefinitions.find((candidate) => candidate.code === code);
	return new BillingError(
		message ?? definition?.message ?? "Trial request failed",
		code,
		definition?.status ?? 400,
		details === undefined ? {} : { details },
	);
}

export function normalizeTrialStartInput(input: TrialStartInput): TrialStartInput {
	const planKey = input.planKey.trim();
	if (planKey === "") throw new InvalidRequestError("planKey is required");
	if (
		input.durationDays !== null &&
		(!Number.isInteger(input.durationDays) ||
			input.durationDays < 1 ||
			input.durationDays > trialDurationMaxDays)
	) {
		throw new InvalidRequestError(
			`durationDays must be a whole number from 1 to ${trialDurationMaxDays}`,
		);
	}
	if (new TextEncoder().encode(JSON.stringify(input.metadata)).length > trialMetadataMaxBytes) {
		throw new InvalidRequestError(
			`metadata must serialize to at most ${trialMetadataMaxBytes} bytes`,
		);
	}
	return { ...input, planKey };
}

export function normalizeTrialEndInput(input: TrialEndInput): TrialEndInput {
	const reason = input.reason?.trim() ?? "";
	if (reason.length > trialEndReasonMaxLength) {
		throw new InvalidRequestError(`reason must be at most ${trialEndReasonMaxLength} characters`);
	}
	return { ...input, reason: reason === "" ? null : reason };
}

/** Identifies what a start asks for, so a reused idempotency key with other terms conflicts. */
export function trialStartRequestHash(input: TrialStartInput): string {
	return sha256Hex(
		stableJson({
			planKey: input.planKey,
			durationDays: input.durationDays,
			metadata: input.metadata,
		}),
	);
}

export function trialEndRequestHash(input: TrialEndInput): string {
	return sha256Hex(stableJson({ trialId: input.trialId, reason: input.reason }));
}
