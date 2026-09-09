import { BillingError, InvalidRequestError } from "../billing/errors";
import type { ProjectInstanceContext } from "../projects/context";
import type { BillingContext } from "./types";

export function privateProject(c: BillingContext): ProjectInstanceContext {
	const project = c.get("project");
	if (project === undefined) {
		throw new BillingError("Billing project context is required", "BILLING_PROJECT_REQUIRED", 401);
	}
	return project;
}

export function requireActor(c: BillingContext): string {
	const actor = c.req.header("x-billing-actor")?.trim();
	if (actor === undefined || actor === "" || actor.length > 200) {
		throw new InvalidRequestError(
			"X-Billing-Actor header must contain between 1 and 200 characters",
		);
	}
	return actor;
}
