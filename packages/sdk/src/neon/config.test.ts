import { describe, expect, it } from "vitest";
import { createNeonClient } from "./client.js";
import { NeonError } from "./errors.js";

describe("createNeonClient apiKey", () => {
	it("refuses an empty string at construction, before fetch", () => {
		let fetches = 0;
		try {
			createNeonClient({
				apiKey: "",
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
					"createNeonClient: `apiKey` is required — pass a string or a function returning one.",
			});
		}
		expect(fetches).toBe(0);
	});

	it("refuses a missing apiKey at construction", () => {
		expect(() => Reflect.apply(createNeonClient, undefined, [{}])).toThrow(
			NeonError,
		);
	});

	it("accepts a non-empty string or a function, including one that returns empty", () => {
		expect(() => createNeonClient({ apiKey: "neon_x" })).not.toThrow();
		expect(() =>
			createNeonClient({ apiKey: () => "neon_x" }),
		).not.toThrow();
		expect(() =>
			createNeonClient({ apiKey: async () => "neon_x" }),
		).not.toThrow();
		expect(() => createNeonClient({ apiKey: () => "" })).not.toThrow();
	});
});

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
