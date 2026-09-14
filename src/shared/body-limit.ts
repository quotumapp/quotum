/**
 * Capped request-body readers shared by raw-body routes on both HTTP surfaces. The caller injects
 * the "too large" error so billing surfaces throw BillingError and the merchant surface throws
 * MerchantError without this module importing either domain.
 */

export type TooLargeErrorFactory = (maxBytes: number) => Error;

const bodyTooLargeFlag = "quotumBodyTooLarge";

/**
 * Domain-neutral "too large" error: surfaces through `isBodyTooLarge` so surface shells can map
 * it onto their own 413 envelope without this module importing either domain.
 */
export function bodyTooLargeError(): Error {
	const error = new Error("Request body is too large");
	Object.defineProperty(error, bodyTooLargeFlag, { value: true });
	return error;
}

/** Default request-body cap for schema-parsed JSON routes (raw routes inject their own). */
export const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;

function tooLargeError(factory: TooLargeErrorFactory, maxBytes: number): Error {
	const error = factory(maxBytes);
	Object.defineProperty(error, bodyTooLargeFlag, { value: true });
	return error;
}

export function isBodyTooLarge(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as Record<string, unknown>)[bodyTooLargeFlag] === true
	);
}

async function readCappedBytes(
	request: Request,
	maxBytes: number,
	tooLarge: TooLargeErrorFactory,
): Promise<Uint8Array> {
	const contentLength = request.headers.get("content-length");
	if (contentLength !== null) {
		const parsedContentLength = Number.parseInt(contentLength, 10);
		if (String(parsedContentLength) === contentLength && parsedContentLength > maxBytes) {
			throw tooLargeError(tooLarge, maxBytes);
		}
	}

	if (request.body === null) {
		return new Uint8Array(0);
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw tooLargeError(tooLarge, maxBytes);
		}

		chunks.push(value);
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return body;
}

export async function readCappedText(
	request: Request,
	maxBytes: number,
	tooLarge: TooLargeErrorFactory,
): Promise<string> {
	const body = await readCappedBytes(request, maxBytes, tooLarge);
	return new TextDecoder().decode(body);
}

/**
 * Parse a JSON body, capping streamed bytes. Mirrors the historical contract: the injected
 * "too large" error propagates, every other failure (malformed JSON included) resolves to `null`
 * so the route schema becomes the single validation authority.
 */
export async function parseCappedJson(
	request: Request,
	maxBytes: number,
	tooLarge: TooLargeErrorFactory,
): Promise<unknown> {
	try {
		const text = await readCappedText(request, maxBytes, tooLarge);
		return JSON.parse(text);
	} catch (error) {
		if (isBodyTooLarge(error)) {
			throw error;
		}
		return null;
	}
}
