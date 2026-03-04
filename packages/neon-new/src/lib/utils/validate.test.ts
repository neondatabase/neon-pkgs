import { describe, expect, it } from "vitest";
import { validateEnvKey, validateEnvPath } from "./validate.js";

describe("validateEnvPath", () => {
	it("returns undefined for valid dotfile paths", () => {
		expect(validateEnvPath(".env")).toBeUndefined();
		expect(validateEnvPath(".env.local")).toBeUndefined();
		expect(validateEnvPath(".env.development")).toBeUndefined();
	});

	it("returns undefined for valid non-dotfile paths", () => {
		expect(validateEnvPath("env")).toBeUndefined();
		expect(validateEnvPath("env-local")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(validateEnvPath("")).toBeUndefined();
	});

	it("returns error for invalid paths", () => {
		expect(validateEnvPath(".env/local")).toBeInstanceOf(Error);
		expect(validateEnvPath("..env")).toBeInstanceOf(Error);
		expect(validateEnvPath(".env..local")).toBeInstanceOf(Error);
	});
});

describe("validateEnvKey", () => {
	it("returns undefined for valid env keys", () => {
		expect(validateEnvKey("DATABASE_URL")).toBeUndefined();
		expect(validateEnvKey("API_KEY_123")).toBeUndefined();
		expect(validateEnvKey("POSTGRES_PASSWORD")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(validateEnvKey("")).toBeUndefined();
	});

	it("returns error for invalid keys", () => {
		expect(validateEnvKey("database_url")).toBeInstanceOf(Error);
		expect(validateEnvKey("123_API_KEY")).toBeInstanceOf(Error);
		expect(validateEnvKey("API-KEY")).toBeInstanceOf(Error);
		expect(validateEnvKey("API.KEY")).toBeInstanceOf(Error);
	});
});
