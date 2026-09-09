import type { ProjectionContract } from "../billing/types";
import {
	type AppleBillingEnv,
	type BillingEnv,
	type GooglePlayBillingEnv,
	loadEnv,
	type StripeBillingEnv,
} from "../env";
import { ProjectionHttpClient, type ProjectionHttpClientOptions } from "../projections/http-client";
import type { RuntimeConnectionResolver } from "../projects/connections";
export interface ProjectConnectionFixture {
	projectInstanceKey: string;
	projectionUrl: string;
	projectionSecret: string;
	projectionContract?: ProjectionContract;
	usageDelivery?: "coalesced" | "off";
	apple?: AppleBillingEnv | null;
	googlePlay?: GooglePlayBillingEnv | null;
	stripe?: StripeBillingEnv | null;
}
export interface FixtureBillingEnv extends BillingEnv {
	connectionFixtures: ProjectConnectionFixture[];
}
/** Explicit injection used by unit tests and guarded fake-provider entrypoints only. */
export function fixtureConnections(
	fixtures: ProjectConnectionFixture[],
): RuntimeConnectionResolver {
	return {
		async resolve(project, kind) {
			const fixture = fixtures.find((row) => row.projectInstanceKey === project.projectInstanceKey);
			if (!fixture) return null;
			const result =
				kind === "projection"
					? {
							projectionUrl: fixture.projectionUrl,
							projectionSecret: fixture.projectionSecret,
							projectionContract: fixture.projectionContract ?? "billing_state_v1",
							usageDelivery: fixture.usageDelivery ?? "coalesced",
						}
					: kind === "google"
						? fixture.googlePlay
						: kind === "apple"
							? fixture.apple
							: fixture.stripe;
			return result ?? null;
		},
	} as RuntimeConnectionResolver;
}
export function loadFixtureEnv(): FixtureBillingEnv {
	if (process.env.BILLING_ENV !== "test")
		throw new Error("Connection fixtures are only available in test mode");
	return {
		...loadEnv(),
		connectionFixtures: JSON.parse(process.env.BILLING_TEST_CONNECTIONS_JSON ?? "[]"),
	};
}
export class FixtureProjectionHttpClient extends ProjectionHttpClient {
	constructor({
		projects,
		...options
	}: Omit<ProjectionHttpClientOptions, "resolveProject"> & {
		projects: ProjectConnectionFixture[];
	}) {
		super({
			...options,
			fetch: options.fetch ?? globalThis.fetch,
			resolveProject: async (key) => {
				const config = projects.find((row) => row.projectInstanceKey === key);
				return config
					? { ...config, projectionContract: config.projectionContract ?? "billing_state_v1" }
					: null;
			},
		});
	}
}
