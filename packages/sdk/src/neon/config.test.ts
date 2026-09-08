import { describe, expect, it } from "vitest";
import { createNeonClient } from "./client.js";
import { NeonError } from "./errors.js";

describe("createNeonClient retries", () => {
	it("refuses NaN at construction, before fetch", () => {
		let fetches = 0;
		try {
			createNeonClient({
				apiKey: "k",
				retries: Number.NaN,
				fetch: async () => {
					fetches += 1;
					return new Response("{}", { status: 200 });
				},
			});
			throw new Error("expected createNeonClient to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(NeonError);
			expect(error).toMatchObject({
				kind: "client",
				message:
					"retries must be a non-negative integer; received NaN.",
			});
		}
		expect(fetches).toBe(0);
	});

	it("accepts 0 and the default", () => {
		expect(() =>
			createNeonClient({ apiKey: "k", retries: 0 }),
		).not.toThrow();
		expect(() => createNeonClient({ apiKey: "k" })).not.toThrow();
	});
});
