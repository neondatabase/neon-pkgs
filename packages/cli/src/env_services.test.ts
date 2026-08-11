import { describe, expect, it } from "vitest";

import {
	ENV_PULL_KEYS,
	envKeysForSelection,
	parseEnvPullKeys,
	servicesForEnvKeys,
} from "./env_services.js";

describe("env pull key selection", () => {
	it("parses repeated and comma-separated keys in canonical order", () => {
		expect(
			parseEnvPullKeys(
				["NEON_AUTH_BASE_URL,DATABASE_URL", "NEON_AUTH_JWKS_URL"],
				"--env",
			),
		).toEqual(["DATABASE_URL", "NEON_AUTH_BASE_URL", "NEON_AUTH_JWKS_URL"]);
	});

	it("rejects unknown keys instead of silently widening the pull", () => {
		expect(() => parseEnvPullKeys(["DATABSE_URL"], "--env")).toThrow(
			`Unknown env variable <redacted invalid value>. Supported values: ${ENV_PULL_KEYS.join(", ")}.`,
		);
	});

	it("does not echo a value pasted into --env", () => {
		expect.assertions(3);
		for (const value of [
			"DATABASE_URL=postgres://user:s3cr3t@example.com/db",
			"napi_live_secret123",
			"secret_prefix,secret_suffix",
		]) {
			try {
				parseEnvPullKeys([value], "--env");
			} catch (error) {
				expect(String(error)).not.toContain(value);
			}
		}
	});

	it("maps selected keys to only the services needed to resolve them", () => {
		expect(
			servicesForEnvKeys([
				"NEON_BRANCH",
				"DATABASE_URL",
				"NEON_AUTH_BASE_URL",
			]),
		).toEqual(["postgres", "auth"]);
	});

	it("unions full service bundles with exact env keys", () => {
		expect(envKeysForSelection(["auth"], ["DATABASE_URL"])).toEqual([
			"DATABASE_URL",
			"NEON_BRANCH",
			"NEON_AUTH_BASE_URL",
			"NEON_AUTH_JWKS_URL",
		]);
	});

	it("does not add NEON_BRANCH to an env-only selection", () => {
		expect(envKeysForSelection([], ["DATABASE_URL"])).toEqual([
			"DATABASE_URL",
		]);
	});

	it("requires the two object-storage credential variables together", () => {
		expect(() => envKeysForSelection([], ["AWS_ACCESS_KEY_ID"])).toThrow(
			/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be selected together.*Add the missing key to --env, or use --service object-storage/,
		);

		expect(
			envKeysForSelection(["object-storage"], ["AWS_ACCESS_KEY_ID"]),
		).toContain("AWS_SECRET_ACCESS_KEY");
	});
});
