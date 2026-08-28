import { describe, expect, test } from "vitest";
import {
	FUNCTION_ARCHIVE_ENTRIES,
	FUNCTION_SOURCE_ENTRIES,
	isFunctionArchiveEntry,
	pickFunctionSourceEntry,
} from "./function-entries.js";

describe("pickFunctionSourceEntry", () => {
	test("prefers index.ts, then index.js, then index.mjs", () => {
		expect(
			pickFunctionSourceEntry(["index.mjs", "index.js", "index.ts"]),
		).toBe("index.ts");
		expect(pickFunctionSourceEntry(["index.mjs", "index.js"])).toBe(
			"index.js",
		);
		expect(pickFunctionSourceEntry(["index.mjs"])).toBe("index.mjs");
	});

	test("returns undefined when none of the source entries are present", () => {
		expect(pickFunctionSourceEntry(["handler.mjs", "index.tsx"])).toBe(
			undefined,
		);
	});

	test("accepts a Set", () => {
		expect(pickFunctionSourceEntry(new Set(["index.js"]))).toBe("index.js");
	});
});

describe("function entry constants", () => {
	test("source discovery order is ts, js, mjs", () => {
		expect(FUNCTION_SOURCE_ENTRIES).toEqual([
			"index.ts",
			"index.js",
			"index.mjs",
		]);
	});

	test("archive entries are the runtime import names", () => {
		expect(FUNCTION_ARCHIVE_ENTRIES).toEqual(["index.mjs", "index.js"]);
		expect(isFunctionArchiveEntry("index.mjs")).toBe(true);
		expect(isFunctionArchiveEntry("index.js")).toBe(true);
		expect(isFunctionArchiveEntry("index.ts")).toBe(false);
	});
});
