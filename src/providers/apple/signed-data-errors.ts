import { VerificationException, VerificationStatus } from "@apple/app-store-server-library";
import { InvalidRequestError, ProviderUnavailableError } from "../../billing/errors";

/** Signed data that is not Apple's, or not for this app and environment, is the sender's error. */
export function appleSignedDataInvalid(message: string): InvalidRequestError {
	return new InvalidRequestError(message, "APPLE_SIGNED_DATA_INVALID");
}

/**
 * Maps a verifier rejection of caller-supplied signed data to a typed error. A retryable failure is
 * an outage of Apple's certificate checks, so it stays retryable; any other error is rethrown as is.
 */
export function signedDataVerificationError(error: unknown): unknown {
	if (!(error instanceof VerificationException)) {
		return error;
	}
	if (error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
		return new ProviderUnavailableError("Apple signed data could not be verified right now");
	}
	return appleSignedDataInvalid("Apple signed data failed verification");
}
