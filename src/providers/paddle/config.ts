import { z } from "zod";
import { BillingError } from "../../billing/errors";
import type { ProjectInstanceContext } from "../../projects/context";

export const paddleConfigSchema = z
	.object({
		apiKey: z.string().regex(/^pdl_sdbx_[A-Za-z0-9_]+$/),
		webhookSecret: z.string().min(20),
		notificationSettingId: z.string().regex(/^ntfset_[a-z0-9]{26}$/),
		paymentPageUrl: z.url().refine((value) => {
			if (!URL.canParse(value)) return false;
			const url = new URL(value);
			return url.protocol === "https:" && !url.username && !url.password && !url.hash;
		}, "The payment page must use HTTPS without credentials or a fragment"),
		clientToken: z.string().regex(/^test_[a-zA-Z0-9]+$/),
	})
	.strict();

export type PaddleConfig = z.infer<typeof paddleConfigSchema>;

export function buildPaddleConfig(project: ProjectInstanceContext, input: unknown): PaddleConfig {
	if (project.environment !== "sandbox" || project.internalProject) {
		throw new BillingError(
			"Paddle is available in sandbox environments only",
			"PADDLE_SANDBOX_ONLY",
			409,
		);
	}
	return paddleConfigSchema.parse(input);
}
