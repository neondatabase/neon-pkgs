import fc from "fast-check";

import protocolSchema from "../../../schema/realtime-protocol-v1.schema.json";

/** The canonical base64 cell pattern, read from the public schema. */
export const base64CellPattern: string =
	protocolSchema.$defs.base64Cell.properties.base64.pattern;

/**
 * Strings that stress the base64 cell grammar: canonical encodings, single
 * edits and truncations of them (which land on padding, length and zero-bit
 * boundaries), and raw runs over the base64 alphabet plus `=`.
 */
export const base64Candidates: fc.Arbitrary<string> = fc.oneof(
	fc
		.uint8Array({ maxLength: 9 })
		.map((bytes) => Buffer.from(bytes).toString("base64")),
	fc
		.tuple(
			fc.uint8Array({ maxLength: 9 }),
			fc.nat({ max: 12 }),
			fc.constantFrom(..."AQgwAEI0+/=*", ""),
		)
		.map(([bytes, index, edit]) => {
			const canonical = Buffer.from(bytes).toString("base64");
			return (
				canonical.slice(0, index) + edit + canonical.slice(index + 1)
			);
		}),
	fc.stringMatching(/^[A-Za-z0-9+/=]{0,16}$/),
);
