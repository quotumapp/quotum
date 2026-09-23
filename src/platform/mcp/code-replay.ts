import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";

/** Bind failed atomic consumption to this grant, including concurrent code redemptions. */
export function containMcpCodeReplay(
	ctx: Pick<GenericEndpointContext, "context">,
	authorizationCodeId: string,
	revokeGrant: () => Promise<unknown>,
	now: () => Date = () => new Date(),
): void {
	const adapter = ctx.context.internalAdapter;
	// Endpoint dispatch copies context; replace only this request's adapter property.
	ctx.context.internalAdapter = {
		...adapter,
		async consumeVerificationValue(identifier) {
			const verification = await adapter.consumeVerificationValue(identifier);
			if (
				identifier === authorizationCodeId &&
				(!verification || verification.expiresAt <= now())
			) {
				await revokeGrant();
				throw new APIError("BAD_REQUEST", {
					error: "invalid_grant",
					error_description: "Reconnect Quotum to authorize access.",
				});
			}
			return verification;
		},
	};
}
