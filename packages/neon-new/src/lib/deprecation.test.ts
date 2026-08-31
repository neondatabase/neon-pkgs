import { afterEach, describe, expect, test, vi } from "vitest";
import { DEPRECATION_MESSAGE, warnDeprecatedOnce } from "./deprecation.js";

describe("deprecation warning", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("names the Claimable Neon CLI successor", () => {
		expect(DEPRECATION_MESSAGE).toContain("npx neon@latest claim create");
	});

	test("SDK import prints the successor command once", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await import("./instant-postgres.js");
		const text = warn.mock.calls.flat().map(String).join("\n");
		expect(text).toContain("npx neon@latest claim create");
		const n = warn.mock.calls.length;
		warnDeprecatedOnce();
		expect(warn.mock.calls.length).toBe(n);
	});
});
