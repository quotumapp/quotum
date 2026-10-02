import type { PromotionRedemptionRecord } from "./promotions";

export interface AppleOfferInput {
	objectKind: "apple_promotional_offer" | "apple_offer_code";
	productExternalId: string;
	offerIdentifier: string;
}

/** Local signing only. The private key never crosses this port. */
export interface ApplePromotionSigner {
	bundleId: string;
	keyId: string;
	sign(input: {
		productId: string;
		offerIdentifier: string;
		appAccountToken: string;
		nonce: string;
		timestamp: number;
	}): string;
}

export interface ApplePromotionAction {
	kind: "provider_action_required";
	provider: "apple";
	duplicate: boolean;
	redemption: PromotionRedemptionRecord;
	appleOffer: {
		productId: string;
		offerIdentifier: string;
		appAccountToken: string;
		keyId: string;
		nonce: string;
		timestamp: number;
		signature: string;
		expiresAt: string;
	};
}
