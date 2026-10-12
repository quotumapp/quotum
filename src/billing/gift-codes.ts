/**
 * The 31 symbols a gift code uses: digits and letters without `0 1 I L O`, which are confused when a
 * code is read aloud or typed from a screen or a card.
 */
export const GIFT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const GIFT_CODE_GROUPS = 5;
export const GIFT_CODE_GROUP_SIZE = 4;
/** Twenty symbols of a 31-symbol alphabet carry about 99 bits, above the 80 bits a bearer secret needs. */
export const GIFT_CODE_SYMBOLS = GIFT_CODE_GROUPS * GIFT_CODE_GROUP_SIZE;

/** Fills `length` bytes from a cryptographic source. */
export type RandomBytes = (length: number) => Uint8Array;

const cryptoRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

/**
 * Bytes at or above this value are discarded: 256 is not a multiple of 31, so mapping them with `%`
 * would make the first symbols likelier than the last.
 */
const ACCEPT_BELOW = 256 - (256 % GIFT_CODE_ALPHABET.length);

/**
 * One gift code such as `K7Q2-M9XD-4TRW-P8HB-3NCF`: twenty symbols in five hyphenated groups. It
 * satisfies the promotion code pattern, so it redeems like any other code. Draws use rejection
 * sampling; `randomBytes` exists so a test can feed known bytes.
 */
export function generateGiftCode(randomBytes: RandomBytes = cryptoRandomBytes): string {
	const symbols: string[] = [];
	while (symbols.length < GIFT_CODE_SYMBOLS) {
		const wanted = GIFT_CODE_SYMBOLS - symbols.length;
		const bytes = randomBytes(wanted);
		if (bytes.length !== wanted) {
			throw new Error("The random source returned an unexpected number of bytes");
		}
		for (const byte of bytes) {
			if (byte >= ACCEPT_BELOW) continue;
			symbols.push(GIFT_CODE_ALPHABET.charAt(byte % GIFT_CODE_ALPHABET.length));
		}
	}
	const groups: string[] = [];
	for (let start = 0; start < GIFT_CODE_SYMBOLS; start += GIFT_CODE_GROUP_SIZE) {
		groups.push(symbols.slice(start, start + GIFT_CODE_GROUP_SIZE).join(""));
	}
	return groups.join("-");
}
