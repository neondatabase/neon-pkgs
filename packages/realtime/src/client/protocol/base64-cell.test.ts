import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isCanonicalBase64Cell } from "./base64-cell.js";
import {
	base64Candidates,
	base64CellPattern,
} from "./base64-cell.test-helpers.js";

const schemaPattern = new RegExp(base64CellPattern, "u");

// [value, accepted]. The expected results are written out by hand, so a wrong
// schema oracle or a wrong checker cannot agree with itself and still pass.
const CASES: ReadonlyArray<readonly [string, boolean]> = [
	// Empty and whole quads.
	["", true],
	["AAAA", true],
	["QUJD", true],
	["+/+/", true],
	["AAAAQUJDAAAA", true],
	["QUIB", true],
	// One trailing byte: second character in [AQgw], then "==".
	["AA==", true],
	["QQ==", true],
	["AQ==", true],
	["Ag==", true],
	["Aw==", true],
	["/w==", true],
	["AE==", false],
	["AB==", false],
	["AR==", false],
	["/x==", false],
	// Two trailing bytes: third character in [AEIMQUYcgkosw048], then "=".
	["AAA=", true],
	["AAE=", true],
	["AAI=", true],
	["AA0=", true],
	["AA4=", true],
	["AAc=", true],
	["QUI=", true],
	["QUJDQUI=", true],
	["QUJDQQ==", true],
	["AAB=", false],
	["AAJ=", false],
	["AAd=", false],
	["AA+=", false],
	["AA/=", false],
	["QUJ=", false],
	// Wrong length, without or with padding.
	["Q", false],
	["QQ", false],
	["QUI", false],
	["QQ=", false],
	["QQ===", false],
	["QUJDQQ", false],
	["QUJDQUI==", false],
	// Padding in the wrong place.
	["====", false],
	["=", false],
	["==AA", false],
	["QQ==QQ==", false],
	["QU==", false],
	["QUJDQ=Q=", false],
	// Characters outside the alphabet, including the URL-safe variants.
	["-_-_", false],
	["QUJ_", false],
	["_w==", false],
	["QUJD\n", false],
	["QUJD ", false],
	[" QUI=", false],
	["QUI= ", false],
	["QUJ\u0000", false],
	["QUJÉ", false],
	["😀AA", false],
];

describe("isCanonicalBase64Cell", () => {
	it("matches the schema pattern on hand-picked edge cases", () => {
		for (const [value, accepted] of CASES) {
			expect(schemaPattern.test(value), JSON.stringify(value)).toBe(
				accepted,
			);
			expect(isCanonicalBase64Cell(value), JSON.stringify(value)).toBe(
				accepted,
			);
		}
	});

	it("matches the schema pattern on random candidates", () => {
		fc.assert(
			fc.property(base64Candidates, (value) => {
				expect(
					isCanonicalBase64Cell(value),
					JSON.stringify(value),
				).toBe(schemaPattern.test(value));
			}),
			{ numRuns: 5000 },
		);
	});
});
