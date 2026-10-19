import { type DomainEventEnvelope, webhookTestEventType } from "./types";

export interface DomainEventExample {
	description: string;
	event: DomainEventEnvelope;
}

const projectKey = "acme";

/**
 * One example per event type, rendered to `contracts/v1/domain-events.examples.json` and validated
 * against the schema by the contract test.
 */
export const domainEventExamples: DomainEventExample[] = [
	{
		description: "A test delivery an operator requested for one endpoint.",
		event: {
			id: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e10",
			type: webhookTestEventType,
			version: 1,
			createdAt: "2026-10-19T08:00:00.000Z",
			occurredAt: "2026-10-19T08:00:00.000Z",
			environment: "sandbox",
			projectKey,
			data: {
				endpointId: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e20",
				message: "A test delivery from Quotum",
			},
		},
	},
];
