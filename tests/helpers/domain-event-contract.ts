import { readFileSync } from "node:fs";
import Ajv, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

type JsonSchema = Record<string, unknown>;

const read = (name: string) =>
	JSON.parse(readFileSync(new URL(`../../contracts/v1/${name}`, import.meta.url), "utf8"));

/** The committed contract, as a receiver would load it. */
export const publishedEventSchema = read("domain-events.schema.json") as JsonSchema;
export const publishedEventExamples = read("domain-events.examples.json") as Array<{
	description: string;
	event: Record<string, unknown>;
}>;

/** Closes every object type that names its properties, so a field the schema omits fails. */
function closed(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(closed);
	if (schema === null || typeof schema !== "object") return schema;
	const copy = Object.fromEntries(
		Object.entries(schema).map(([key, value]) => [key, closed(value)]),
	);
	return copy.type === "object" && "properties" in copy
		? { ...copy, additionalProperties: false }
		: copy;
}

function compile(schema: JsonSchema): ValidateFunction {
	const ajv = new Ajv({ strict: false, allErrors: true });
	addFormats(ajv);
	return ajv.compile(schema);
}

/** Validates as a receiver does: unknown fields are accepted. */
export const validateEvent = compile(publishedEventSchema);
/** Also rejects a field the published schema does not name. */
export const validateDocumentedEvent = compile(closed(publishedEventSchema) as JsonSchema);
