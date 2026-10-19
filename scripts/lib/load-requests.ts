/** Request bodies shared by the load lane and the strict public usage schemas. */
export const loadFeatureKey = "model_tokens";

export function checkRequestBody(value = "1"): { featureId: string; value: string } {
	return { featureId: loadFeatureKey, value };
}

export function consumeRequestBody(value = "1"): { featureId: string; value: string } {
	return { featureId: loadFeatureKey, value };
}

export function reserveRequestBody(
	value: string,
	expiresInSeconds = 60,
): { featureId: string; value: string; expiresInSeconds: number } {
	return { featureId: loadFeatureKey, value, expiresInSeconds };
}

export function confirmRequestBody(value: string): { value: string } {
	return { value };
}
