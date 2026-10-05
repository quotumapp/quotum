import { z } from "zod";
import { RejectedProviderWrite } from "../../billing/provider-operations";
import { type PaddleClient, PaddleWriteUncertain } from "./client";
import {
	PADDLE_UNAVAILABLE,
	type PaddleExistingCustomerReason,
	paddleExistingCustomerReceiptCode,
} from "./operation-errors";
import { paddleId } from "./schemas";

const existingCustomerSchema = z.object({
	id: paddleId("ctm"),
	email: z.email(),
	status: z.enum(["active", "archived"]),
});

/** Paddle names the conflicting customer in its 409 detail; the id is only a hint to read. */
export function paddleCustomerIdFromDetail(detail: string | null): string | null {
	const candidate = detail?.match(/\bctm_[a-z0-9]{26}\b/)?.[0];
	return candidate === undefined ? null : candidate;
}

/**
 * After `409 customer_already_exists`, resolves the one customer Paddle holds for the email and
 * links it to the billing account, unless another account already holds it. Every read goes through
 * the shared client, so the rate-limit cooldown applies. Throws a definitive rejection that names the
 * reason; nothing is linked unless the customer is active, matches the email and is unclaimed.
 */
export async function adoptExistingPaddleCustomer(input: {
	client: Pick<PaddleClient, "get">;
	claim: (customerId: string) => Promise<"linked" | "claimed">;
	email: string;
	hintedCustomerId: string | null;
}): Promise<{ customerId: string }> {
	const refuse = (reason: PaddleExistingCustomerReason): never => {
		throw new RejectedProviderWrite(paddleExistingCustomerReceiptCode(reason));
	};
	let candidates: z.infer<typeof existingCustomerSchema>[];
	try {
		candidates =
			input.hintedCustomerId === null
				? await lookUpByEmail(input.client, input.email)
				: [
						existingCustomerSchema.parse(
							(await input.client.get(`/customers/${input.hintedCustomerId}`)).data,
						),
					];
	} catch (error) {
		// A read has no effect to reconcile: an outage after the rejected create is a plain failure.
		if (error instanceof PaddleWriteUncertain || error instanceof z.ZodError)
			throw new RejectedProviderWrite(PADDLE_UNAVAILABLE);
		throw error;
	}
	const sameEmail = candidates.filter(
		(customer) => customer.email.toLowerCase() === input.email.toLowerCase(),
	);
	if (sameEmail.length === 0) return refuse(candidates.length > 0 ? "email_mismatch" : "ambiguous");
	const active = sameEmail.filter((customer) => customer.status === "active");
	if (active.length === 0) return refuse("inactive");
	const [customer] = active;
	if (active.length !== 1 || customer === undefined) return refuse("ambiguous");
	if ((await input.claim(customer.id)) === "claimed") return refuse("claimed");
	return { customerId: customer.id };
}

async function lookUpByEmail(client: Pick<PaddleClient, "get">, email: string) {
	const response = await client.get(
		`/customers?${new URLSearchParams({ email, per_page: "200", status: "active,archived" })}`,
	);
	// A partial scan could miss a second match, so it cannot establish a single customer.
	if (response.meta?.pagination?.has_more !== false)
		throw new RejectedProviderWrite(paddleExistingCustomerReceiptCode("ambiguous"));
	return z.array(existingCustomerSchema).parse(response.data);
}
