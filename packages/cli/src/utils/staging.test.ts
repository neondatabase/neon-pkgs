import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
	// A profile selected from the developer's shell would bring its own recorded host.
	beforeEach(() => {
		vi.stubEnv("NEON_PROFILE", "");
		vi.stubEnv("NEON_API_KEY", "");
	});
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

	test("a selected profile's recorded host decides over NEON_API_HOST", () => {
		const dir = mkdtempSync(join(tmpdir(), "neon-staging-profile-"));
		try {
			writeFileSync(
				join(dir, "profiles.json"),
				JSON.stringify({
					version: 1,
					profiles: {
						staging: {
							credentials: "credentials.staging.json",
							apiHost: STAGING_API_HOST,
						},
					},
				}),
			);
			vi.stubEnv("NEON_API_HOST", PRODUCTION_API_HOST);
			const args = ["projects", "list", "--config-dir", dir];
			expect(
				stagingFeaturesEnabledForArgv([
					...args,
					"--profile",
					"staging",
				]),
			).toBe(true);
			expect(stagingFeaturesEnabledForArgv(args)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
