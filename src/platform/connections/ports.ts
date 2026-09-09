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
export interface EnvironmentBillingPort {
	catalogReadiness(
		instanceId: string,
	): Promise<{ revisionId: string | null; providers: string[]; ready: boolean }>;
	promote(input: {
		sourceInstanceId: string;
		targetInstanceId: string;
		actor: string;
		previewId?: string;
	}): Promise<unknown>;
}
