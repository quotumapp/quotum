import type { ReadinessBlockerDetail } from "../contracts";
import type { ConnectionKind } from "./repository";

export interface ConnectionInput {
	settings: Record<string, unknown>;
	secrets: Record<string, string>;
}
export interface ConnectionValidation {
	identity: string;
	eventVerified: boolean;
	checks: { code: string; passed: boolean }[];
}
/** Composition implements provider I/O; the platform never imports billing repositories or clients. */
export interface ConnectionValidationPort {
	normalize(
		kind: ConnectionKind,
		environment: "sandbox" | "production",
		input: ConnectionInput,
	): ConnectionInput;
	validate(
		kind: ConnectionKind,
		environment: "sandbox" | "production",
		input: ConnectionInput,
		context: { instanceId: string; instanceKey: string; versionId: string },
	): Promise<ConnectionValidation>;
}
/** The connection state readiness reads; `ConnectionRepository.list` rows satisfy it. */
export interface ReadinessConnectionState {
	kind: ConnectionKind;
	enabled: boolean;
	active_version_id: string | null;
	validated_at: Date | null;
	settings: Record<string, unknown> | null;
}
/** A non-gating readiness finding about the published catalog; readiness adds `gating: false`. */
export type ReadinessCapabilityDetail = Omit<ReadinessBlockerDetail, "gating">;
export interface EnvironmentBillingPort {
	catalogReadiness(
		instanceId: string,
		connections: readonly ReadinessConnectionState[],
	): Promise<{
		revisionId: string | null;
		providers: string[];
		ready: boolean;
		capabilityDetails?: ReadinessCapabilityDetail[];
	}>;
	promote(input: {
		sourceInstanceId: string;
		targetInstanceId: string;
		actor: string;
		previewId?: string;
	}): Promise<unknown>;
}
