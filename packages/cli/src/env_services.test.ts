import { describe, expect, it } from "vitest";

import {
	ENV_PULL_KEY_HELP,
	envKeysForSelection,
	isLegacyFunctionBaseUrlKey,
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
			`Unknown env variable <redacted invalid value>. Did you mean DATABASE_URL? Supported values: ${ENV_PULL_KEY_HELP}.`,
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
		expect(
			servicesForEnvKeys(["NEON_REALTIME_URL", "NEON_REALTIME_SECRET"]),
		).toEqual(["realtime"]);
	});

	it("unions full service bundles with exact env keys", () => {
		expect(envKeysForSelection(["auth"], ["DATABASE_URL"])).toEqual([
			"DATABASE_URL",
			"NEON_BRANCH",
			"NEON_BRANCH_ID",
			"NEON_AUTH_BASE_URL",
			"NEON_AUTH_JWKS_URL",
		]);
	});

	it("selects the complete Realtime env bundle", () => {
		expect(envKeysForSelection(["realtime"], [])).toEqual([
			"NEON_BRANCH",
			"NEON_BRANCH_ID",
			"NEON_REALTIME_URL",
			"NEON_REALTIME_SECRET",
		]);
	});

	it("does not add NEON_BRANCH to an env-only selection", () => {
		expect(envKeysForSelection([], ["DATABASE_URL"])).toEqual([
			"DATABASE_URL",
		]);
	});

	it("points a legacy function URL key at functionBaseUrl", () => {
		expect(() =>
			parseEnvPullKeys(["NEON_FUNCTION_HELLO_BASE_URL"], "--env"),
		).toThrow(
			'NEON_FUNCTION_HELLO_BASE_URL is no longer pulled. Pull NEON_BRANCH_ID and NEON_FUNCTION_HOST_SUFFIX with `--service functions`, then build the URL with `functionBaseUrl("hello")` from @neon/env.',
		);
	});

	it("maps the function host suffix to the functions service", () => {
		expect(servicesForEnvKeys(["NEON_FUNCTION_HOST_SUFFIX"])).toEqual([
			"functions",
		]);
		expect(servicesForEnvKeys(["NEON_BRANCH_ID"])).toEqual([]);
	});

	it("--service functions selects the branch identity and the host suffix", () => {
		expect(envKeysForSelection(["functions"], [])).toEqual([
			"NEON_BRANCH",
			"NEON_BRANCH_ID",
			"NEON_FUNCTION_HOST_SUFFIX",
		]);
	});

	it("recognizes only the legacy per-function URL keys", () => {
		expect(isLegacyFunctionBaseUrlKey("NEON_FUNCTION_HELLO_BASE_URL")).toBe(
			true,
		);
		expect(isLegacyFunctionBaseUrlKey("NEON_FUNCTION_HOST_SUFFIX")).toBe(
			false,
		);
		expect(isLegacyFunctionBaseUrlKey("NEON_FUNCTION_REGISTRY_URL")).toBe(
			false,
		);
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
