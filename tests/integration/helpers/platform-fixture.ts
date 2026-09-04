import type {
	ProjectInstanceContext,
	ProjectInstanceContextResolver,
} from "../../../src/projects/context";
import { projectInstanceContext } from "../../helpers/project-context";

let cachedContexts: readonly ProjectInstanceContext[] | null = null;
let cachedCredentials: Readonly<Record<string, string>> | null = null;

export function integrationProjectContext(projectInstanceKey = "voysee"): ProjectInstanceContext {
	const context = integrationProjectContexts().find(
		(candidate) => candidate.projectInstanceKey === projectInstanceKey,
	);
	if (context === undefined) {
		throw new Error(`Integration project context ${projectInstanceKey} is not configured`);
	}
	return context;
}

export function integrationProjectContexts(): readonly ProjectInstanceContext[] {
	return contexts();
}

export function integrationProjectCredential(projectInstanceKey = "voysee"): string {
	const credential = credentials()[projectInstanceKey];
	if (credential === undefined) {
		throw new Error(`Integration project credential ${projectInstanceKey} is not configured`);
	}
	return credential;
}

export function integrationProjectContextResolver(): ProjectInstanceContextResolver {
	return {
		async resolveCredential(credential) {
			const projectInstanceKey = Object.entries(credentials()).find(
				([, candidate]) => candidate === credential,
			)?.[0];
			if (projectInstanceKey === undefined) return { kind: "not_found" };
			return { kind: "resolved", context: integrationProjectContext(projectInstanceKey) };
		},
		async resolveInstanceKey(projectInstanceKey) {
			const context = integrationProjectContexts().find(
				(candidate) => candidate.projectInstanceKey === projectInstanceKey,
			);
			return context === undefined ? { kind: "not_found" } : { kind: "resolved", context };
		},
		async resolveInstanceId(projectInstanceId) {
			const context = integrationProjectContexts().find(
				(candidate) => candidate.projectInstanceId === projectInstanceId,
			);
			return context === undefined ? { kind: "not_found" } : { kind: "resolved", context };
		},
	};
}

function contexts(): readonly ProjectInstanceContext[] {
	if (cachedContexts !== null) return cachedContexts;
	const raw = process.env.BILLING_TEST_PROJECT_CONTEXTS_JSON;
	if (raw === undefined) {
		cachedContexts = [projectInstanceContext(), projectInstanceContext("wiseley")];
		return cachedContexts;
	}
	const value = JSON.parse(raw) as unknown;
	if (!Array.isArray(value)) throw new Error("BILLING_TEST_PROJECT_CONTEXTS_JSON is invalid");
	cachedContexts = value as ProjectInstanceContext[];
	return cachedContexts;
}

function credentials(): Readonly<Record<string, string>> {
	if (cachedCredentials !== null) return cachedCredentials;
	const raw = process.env.BILLING_TEST_PROJECT_CREDENTIALS_JSON;
	if (raw === undefined) {
		cachedCredentials = {
			voysee: "voysee-integration-api-key",
			wiseley: "wiseley-integration-api-key",
		};
		return cachedCredentials;
	}
	const value = JSON.parse(raw) as unknown;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("BILLING_TEST_PROJECT_CREDENTIALS_JSON is invalid");
	}
	cachedCredentials = value as Record<string, string>;
	return cachedCredentials;
}
