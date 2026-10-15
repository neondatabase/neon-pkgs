import { afterEach, describe, expect, test, vi } from "vitest";
import {
	isStagingApiHost,
	STAGING_API_HOST,
	stagingFeaturesEnabledForArgv,
} from "./staging.js";

const PRODUCTION_API_HOST = "https://console.neon.tech/api/v2";

describe("isStagingApiHost", () => {
	test.each([
		[STAGING_API_HOST, true],
		["https://console-stage.neon.build", true],
		[PRODUCTION_API_HOST, false],
		["https://console-stage.neon.build.example.com/api/v2", false],
		["http://localhost:8080", false],
		["not a url", false],
		[undefined, false],
	])("%s -> %s", (apiHost, expected) => {
		expect(isStagingApiHost(apiHost)).toBe(expected);
	});
});

describe("stagingFeaturesEnabledForArgv", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("--api-host decides over NEON_API_HOST", () => {
		vi.stubEnv("NEON_API_HOST", STAGING_API_HOST);
		expect(
			stagingFeaturesEnabledForArgv(["--api-host", PRODUCTION_API_HOST]),
		).toBe(false);

		vi.stubEnv("NEON_API_HOST", PRODUCTION_API_HOST);
		expect(
			stagingFeaturesEnabledForArgv([`--api-host=${STAGING_API_HOST}`]),
		).toBe(true);
	});

	test("--apiHost decides over NEON_API_HOST", () => {
		vi.stubEnv("NEON_API_HOST", STAGING_API_HOST);
		expect(
			stagingFeaturesEnabledForArgv(["--apiHost", PRODUCTION_API_HOST]),
		).toBe(false);

		vi.stubEnv("NEON_API_HOST", PRODUCTION_API_HOST);
		expect(
			stagingFeaturesEnabledForArgv(["--apiHost", STAGING_API_HOST]),
		).toBe(true);
	});

	test("falls back to NEON_API_HOST without --api-host", () => {
		vi.stubEnv("NEON_API_HOST", STAGING_API_HOST);
		expect(stagingFeaturesEnabledForArgv(["projects", "list"])).toBe(true);

		vi.stubEnv("NEON_API_HOST", "");
		expect(stagingFeaturesEnabledForArgv(["projects", "list"])).toBe(false);
	});
});
