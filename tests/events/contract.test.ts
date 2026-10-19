import { describe, expect, it } from "bun:test";
import { domainEventDeliverySchema, domainEventsJsonSchema } from "../../src/events/contract";
import { domainEventExamples } from "../../src/events/examples";
import { deliverableEventTypes } from "../../src/events/types";
import {
	publishedEventExamples,
	publishedEventSchema,
	validateDocumentedEvent,
	validateEvent,
} from "../helpers/domain-event-contract";

describe("domain event contract", () => {
	it("publishes the schema and examples the code renders", () => {
		expect(publishedEventSchema).toEqual(JSON.parse(JSON.stringify(domainEventsJsonSchema())));
		expect(publishedEventExamples).toEqual(JSON.parse(JSON.stringify(domainEventExamples)));
	});

	it("has an example for every deliverable type, each valid and fully documented", () => {
		expect(publishedEventExamples.map((example) => example.event.type).sort()).toEqual(
			deliverableEventTypes().sort(),
		);
		for (const example of publishedEventExamples) {
			expect(validateEvent(example.event)).toBe(true);
			expect(validateDocumentedEvent(example.event)).toBe(true);
			expect(domainEventDeliverySchema.safeParse(example.event).success).toBe(true);
		}
	});

	it("lets receivers ignore fields it does not name, and refuses a wrong version", () => {
		const event = structuredClone(publishedEventExamples[0]?.event ?? {});

		expect(validateEvent({ ...event, addedLater: true })).toBe(true);
		expect(validateDocumentedEvent({ ...event, addedLater: true })).toBe(false);
		expect(validateEvent({ ...event, version: 2 })).toBe(false);
		expect(validateEvent({ ...event, id: "not-a-uuid" })).toBe(false);
	});
});
