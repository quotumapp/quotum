import type { QuotumEmailConfig } from "./config";
import { ResendMerchantMailer } from "./resend-email";
import { MerchantError } from "./security";

export interface MerchantEmail {
	to: string;
	kind: "verification" | "reset" | "otp" | "invitation" | "invite_request";
	subject: string;
	text: string;
	html: string;
}
export interface MerchantMailer {
	send(message: MerchantEmail): Promise<void>;
}

export function createMerchantMailer(
	config: QuotumEmailConfig,
	transport: typeof fetch = fetch,
	wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): MerchantMailer {
	switch (config.provider) {
		case "cloudflare":
			return new CloudflareMerchantMailer(config, transport, wait);
		case "resend":
			return new ResendMerchantMailer(config, transport, wait);
	}
}
export function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
	);
}
export function linkMessage(
	to: string,
	kind: "verification" | "reset" | "invitation",
	subject: string,
	link: string,
): MerchantEmail {
	return {
		to,
		kind,
		subject,
		text: `${subject}\n\n${link}\n\nIf you did not request this, ignore this email.`,
		html: `<p>${escapeHtml(subject)}</p><p><a href="${escapeHtml(link)}">Continue to Quotum</a></p><p>If you did not request this, ignore this email.</p>`,
	};
}
export class CloudflareMerchantMailer implements MerchantMailer {
	constructor(
		private readonly config: Omit<
			Extract<QuotumEmailConfig, { provider: "cloudflare" }>,
			"provider"
		>,
		private readonly transport: typeof fetch = fetch,
		private readonly wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
	) {}
	async send(message: MerchantEmail): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			let response: Response;
			try {
				response = await this.transport(
					`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.config.accountId)}/email/sending/send`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${this.config.apiToken}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							from: { address: this.config.from, name: "Quotum" },
							to: message.to,
							subject: message.subject,
							text: message.text,
							html: message.html,
						}),
						signal: AbortSignal.timeout(10_000),
					},
				);
			} catch {
				throw new MerchantError(
					"EMAIL_DELIVERY_FAILED",
					"We could not send the email. Please try again.",
					503,
				);
			}
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
			const data: unknown = await response.json().catch(() => null);
			if (data && typeof data === "object" && "success" in data && data.success === true) {
				const result =
					"result" in data && typeof data.result === "object" && data.result ? data.result : null;
				if (
					result &&
					"permanent_bounces" in result &&
					Array.isArray(result.permanent_bounces) &&
					result.permanent_bounces.includes(message.to)
				)
					break;
				return;
			}
			break;
		}
		throw new MerchantError(
			"EMAIL_DELIVERY_FAILED",
			"We could not send the email. Please try again.",
			503,
		);
	}
}
