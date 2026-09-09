export interface StripeOAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	accountId: string;
	livemode: boolean;
}
export interface StripeOAuthPort {
	authorize(environment: "sandbox" | "production", state: string): string;
	exchange(environment: "sandbox" | "production", code: string): Promise<StripeOAuthTokens>;
	refresh(environment: "sandbox" | "production", token: string): Promise<StripeOAuthTokens>;
	webhookSecret(environment: "sandbox" | "production"): string;
}
