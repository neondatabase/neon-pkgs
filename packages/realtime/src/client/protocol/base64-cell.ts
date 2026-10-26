// Second character of a one-byte padded quad: the low four bits must be zero.
const ONE_BYTE_TAIL = "AQgw";
// Third character of a two-byte padded quad: the low two bits must be zero.
const TWO_BYTE_TAIL = "AEIMQUYcgkosw048";

/**
 * Linear-time check for the schema's `base64Cell` pattern.
 *
 * The generated validator runs that pattern as a RegExp. V8's backtracking
 * engine keeps a stack frame for each repetition of the
 * `(?:[A-Za-z0-9+/]{4})*` group, so a value of about 4.47M characters (a bytea
 * of roughly 3.2 MiB) throws `RangeError: Maximum call stack size exceeded`.
 * Realtime delivers rows up to 4 MiB, so the generator routes this one pattern
 * here. Every other pattern stays a RegExp.
 *
 * The function accepts exactly the strings the pattern accepts:
 *
 * - the length is a multiple of four, and "" is accepted;
 * - every quad before the last is four characters from the base64 alphabet;
 * - the last quad is either four alphabet characters, or one of the two padded
 *   forms from RFC 4648 with zero padding bits:
 *   - `xA==`, `xQ==`, `xg==`, `xw==`: one trailing byte, so the second
 *     character's low four bits are zero;
 *   - `xyA=` with `A` in `AEIMQUYcgkosw048`: two trailing bytes, so the third
 *     character's low two bits are zero.
 *
 * The schema stays the source of truth. The generator refuses to emit this
 * checker for any other base64 pattern, and the tests compare it with the
 * pattern on hand-picked and random inputs.
 */
export function isCanonicalBase64Cell(value: string): boolean {
	const length = value.length;
	if (length % 4 !== 0) return false;

	const lastQuad = length - 4;
	for (let index = 0; index < lastQuad; index += 1) {
		if (!isBase64Digit(value.charCodeAt(index))) return false;
	}
	return length === 0 || isFinalQuad(value.slice(lastQuad));
}

function isFinalQuad(quad: string): boolean {
	if (quad.charAt(3) !== "=") {
		return (
			isBase64Digit(quad.charCodeAt(0)) &&
			isBase64Digit(quad.charCodeAt(1)) &&
			isBase64Digit(quad.charCodeAt(2)) &&
			isBase64Digit(quad.charCodeAt(3))
		);
	}
	if (!isBase64Digit(quad.charCodeAt(0))) return false;
	if (quad.charAt(2) === "=") return ONE_BYTE_TAIL.includes(quad.charAt(1));
	return (
		isBase64Digit(quad.charCodeAt(1)) &&
		TWO_BYTE_TAIL.includes(quad.charAt(2))
	);
}

// RFC 4648 section 4 alphabet: A-Z, a-z, 0-9, "+" and "/".
function isBase64Digit(code: number): boolean {
	return (
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x2b ||
		code === 0x2f
	);
}
