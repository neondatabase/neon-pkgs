import { describe, expect, test } from "vitest";
import { decodeBinaryFields } from "./envelope.js";

describe("decodeBinaryFields", () => {
	test("decodes named string fields and leaves the rest", () => {
		const blob = new Blob(["hi"]);
		expect(
			decodeBinaryFields(
				{ zip: "aGVsbG8=", runtime: "deno" },
				["zip"],
				() => blob,
			),
		).toEqual({ zip: blob, runtime: "deno" });
	});
});
