import type { QuotumEmailConfig } from "./config";
import type { MerchantEmail, MerchantMailer } from "./email";
import { MerchantError } from "./security";

export class ResendMerchantMailer implements MerchantMailer {
	constructor(
		private readonly config: Extract<QuotumEmailConfig, { provider: "resend" }>,
		private readonly transport: typeof fetch = fetch,
		private readonly wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
	) {}

	async send(message: MerchantEmail): Promise<void> {
		// Reuse this key only for retries of this send, never for a new OTP or invitation.
		const idempotencyKey = crypto.randomUUID();
		const body = JSON.stringify({
			from: `Quotum <${this.config.from}>`,
			to: [message.to],
			subject: message.subject,
			text: message.text,
			html: message.html,
		});
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				const response = await this.transport("https://api.resend.com/emails", {
					method: "POST",
					headers: {
						authorization: `Bearer ${this.config.apiKey}`,
						"content-type": "application/json",
						"idempotency-key": idempotencyKey,
					},
					body,
					signal: AbortSignal.timeout(10_000),
				});
				if ((response.status === 429 || response.status >= 500) && attempt < 2) {
					const seconds = Number(response.headers.get("retry-after"));
					await response.body?.cancel();
					await this.wait(
						Number.isFinite(seconds) && seconds > 0
							? Math.min(seconds * 1000, 5000)
							: 250 * 2 ** attempt,
					);
					continue;
				}
				if (!response.ok) {
					await response.body?.cancel();
					break;
				}
				const data: unknown = await response.json();
				if (
					data &&
					typeof data === "object" &&
					"id" in data &&
					typeof data.id === "string" &&
					data.id.trim().length > 0
				)
					return;
				break;
			}
		} catch {
			// Provider responses, credentials and transport exceptions must stay private.
		}
		throw new MerchantError(
			"EMAIL_DELIVERY_FAILED",
			"We could not send the email. Please try again.",
			503,
		);
	}
}
