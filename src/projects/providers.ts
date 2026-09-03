export interface ProjectProviderServices<AppleService, GoogleService, StripeService> {
	appleStoreKitService: AppleService | null;
	googlePlayBillingService: GoogleService | null;
	stripeBillingService: StripeService | null;
}

export type ProjectProviderServiceOverrides<AppleService, GoogleService, StripeService> = Record<
	string,
	Partial<ProjectProviderServices<AppleService, GoogleService, StripeService>>
>;
