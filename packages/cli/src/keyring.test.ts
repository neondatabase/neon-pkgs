import { describe, expect, test } from "vitest";
import { keyringPasswordLimit } from "./keyring.js";

describe("keyringPasswordLimit", () => {
	test("is 1280 UTF-16 code units on Windows", () => {
		expect(keyringPasswordLimit("win32")).toBe(1280);
	});

	test.each(["darwin", "linux"] as const)("is unset on %s", (platform) => {
		expect(keyringPasswordLimit(platform)).toBeUndefined();
	});
});
