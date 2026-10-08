import { readFileSync } from "node:fs";
import Ajv, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

type JsonSchema = Record<string, unknown>;

const read = (name: string) =>
	JSON.parse(readFileSync(new URL(`../../contracts/v1/${name}`, import.meta.url), "utf8"));

/** The committed contract, as a receiver would load it. */
export const publishedDeliverySchema = read("projection-delivery.schema.json") as JsonSchema;
export const publishedDeliveryExamples = read("projection-delivery.examples.json") as Record<
	string,
	{ description: string; delivery: Record<string, unknown> }
>;

/** Closes every object type that names its properties, so a field the schema omits fails. */
function closed(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(closed);
	if (schema === null || typeof schema !== "object") return schema;
	const copy = Object.fromEntries(
		Object.entries(schema).map(([key, value]) => [key, closed(value)]),
	);
	// A condition such as `if` names properties too, but is not an object type to close.
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
export const validateDelivery = compile(publishedDeliverySchema);
/** Also rejects a field the published schema does not name; the schema itself stays open. */
export const validateDocumentedDelivery = compile(closed(publishedDeliverySchema) as JsonSchema);

/** The delivery's structure: every key, with each value reduced to its JSON type. */
export function deliveryShape(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(deliveryShape);
	if (value === null) return "null";
	if (typeof value !== "object") return typeof value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b, "en"))
			.map(([key, member]) => [key, deliveryShape(member)]),
	);
}
