/**
 * The request bodies the load lane sends. Check and consume name the feature by `featureId` and the
 * amount by `value`; reserve names the feature by `featureKey` and the amount by `quantity`, and
 * confirm carries only `quantity`. All four bodies are strict, so a key the API does not know is a
 * 400 for every request. `tests/scripts/load-requests.test.ts` parses these against the routes'
 * own schemas, so a contract change fails the unit suite instead of a lane nobody runs.
 */
export const loadFeatureKey = "model_tokens";

export function checkRequestBody(value = "1"): { featureId: string; value: string } {
	return { featureId: loadFeatureKey, value };
}

export function consumeRequestBody(value = "1"): { featureId: string; value: string } {
	return { featureId: loadFeatureKey, value };
}

export function reserveRequestBody(
	quantity: string,
	expiresInSeconds = 60,
): { featureKey: string; quantity: string; expiresInSeconds: number } {
	return { featureKey: loadFeatureKey, quantity, expiresInSeconds };
}

export function confirmRequestBody(quantity: string): { quantity: string } {
	return { quantity };
}
