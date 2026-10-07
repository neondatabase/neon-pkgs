import { describe, expect, test } from "vitest";
import type { NeonAuthConfig } from "@/server/config";
import { ERRORS } from "@/server/errors";
import { createNeonAuth } from "./index";

const createAuthConfig = (
	overrides?: Partial<NeonAuthConfig["cookies"]>,
): NeonAuthConfig => ({
	baseUrl: "https://auth.example.com",
	cookies: {
		secret: "x".repeat(32),
		...overrides,
	},
});

describe("config validation", () => {
	test("accepts valid config with all fields", () => {
		const config = createAuthConfig({
			secret: "x".repeat(32),
			sessionDataTtl: 300,
			domain: ".example.com",
		});

		expect(() => createNeonAuth(config)).not.toThrow();
	});

	test("accepts valid config with minimal fields", () => {
		const config = createAuthConfig();

		expect(() => createNeonAuth(config)).not.toThrow();
	});

	test("throws when cookies.secret is missing", () => {
		const config = {
			baseUrl: "https://auth.example.com",
			cookies: {} as NeonAuthConfig["cookies"],
		};

		expect(() => createNeonAuth(config)).toThrow(
			ERRORS.MISSING_COOKIE_SECRET,
		);
	});

	test("throws when cookies.secret is too short", () => {
		const config = createAuthConfig({ secret: "short-secret" });

		expect(() => createNeonAuth(config)).toThrow("at least 32 characters");
	});

	test("accepts cookies.secret with exactly 32 characters", () => {
		const config = createAuthConfig({ secret: "x".repeat(32) });

		expect(() => createNeonAuth(config)).not.toThrow();
	});

	test("accepts cookies.secret with more than 32 characters", () => {
		const config = createAuthConfig({ secret: "x".repeat(64) });

		expect(() => createNeonAuth(config)).not.toThrow();
	});

	test("throws when sessionDataTtl is zero", () => {
		const config = createAuthConfig({ sessionDataTtl: 0 });

		expect(() => createNeonAuth(config)).toThrow("positive number");
	});

	test("throws when sessionDataTtl is negative", () => {
		const config = createAuthConfig({ sessionDataTtl: -5 });

		expect(() => createNeonAuth(config)).toThrow("positive number");
	});

	test("accepts undefined sessionDataTtl", () => {
		const config = createAuthConfig({ sessionDataTtl: undefined });

		expect(() => createNeonAuth(config)).not.toThrow();
	});

	test("accepts positive sessionDataTtl", () => {
		const config = createAuthConfig({ sessionDataTtl: 600 });

		expect(() => createNeonAuth(config)).not.toThrow();
	});

	test("accepts domain as string", () => {
		const config = createAuthConfig({ domain: ".example.com" });

		expect(() => createNeonAuth(config)).not.toThrow();
	});

	test("accepts undefined domain", () => {
		const config = createAuthConfig({ domain: undefined });

		expect(() => createNeonAuth(config)).not.toThrow();
	});

	test.each([
		"strict",
		"lax",
		"none",
	] as const)("accepts cookies.sameSite=%s", (sameSite) => {
		const config = createAuthConfig({ sameSite });

		expect(() => createNeonAuth(config)).not.toThrow();
	});
});

describe("return value structure", () => {
	test("returns object with handler method", () => {
		const config = createAuthConfig();
		const auth = createNeonAuth(config);

		expect(typeof auth.handler).toBe("function");
	});

	test("returns object with middleware method", () => {
		const config = createAuthConfig();
		const auth = createNeonAuth(config);

		expect(typeof auth.middleware).toBe("function");
	});
});
