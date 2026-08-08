import { describe, expect, it } from "vitest";

import {
	envServiceKeys,
	ownedEnvServiceKeys,
	parseEnvServices,
	unselectedSecretEnvKeys,
} from "./env_services.js";

describe("parseEnvServices", () => {
	it("accepts the flag repeated", () => {
		expect(parseEnvServices(["ai-gateway", "postgres"])).toEqual([
			"postgres",
			"ai-gateway",
		]);
	});

	it("accepts comma-separated values, and a mix of both", () => {
		expect(parseEnvServices(["auth,data-api", "postgres"])).toEqual([
			"postgres",
			"auth",
			"data-api",
		]);
	});

	it("orders canonically and deduplicates, so typing order never changes the file", () => {
		expect(
			parseEnvServices(["ai-gateway", "auth", "ai-gateway", "postgres"]),
		).toEqual(["postgres", "auth", "ai-gateway"]);
	});

	it("tolerates surrounding whitespace and empty segments", () => {
		expect(parseEnvServices([" auth , ", "postgres"])).toEqual([
			"postgres",
			"auth",
		]);
	});

	it("rejects an unknown service rather than pulling everything but it", () => {
		expect(() => parseEnvServices(["postgres", "storage"])).toThrow(
			/Unknown service storage\..*object-storage/s,
		);
	});

	it("rejects a numeric-looking value, which yargs can hand over as a string", () => {
		expect(() => parseEnvServices(["5"])).toThrow(/Unknown service 5\./);
	});

	it("rejects an empty selection", () => {
		expect(() => parseEnvServices([" "])).toThrow(
			/needs at least one service/,
		);
	});
});

describe("envServiceKeys", () => {
	it("always includes branch identity, which is not a service", () => {
		expect([...envServiceKeys(["ai-gateway"])].sort()).toEqual([
			"NEON_AI_GATEWAY_BASE_URL",
			"NEON_AI_GATEWAY_TOKEN",
			"NEON_BRANCH",
		]);
	});

	it("unions the selected services", () => {
		expect([...envServiceKeys(["postgres", "data-api"])].sort()).toEqual([
			"DATABASE_URL",
			"DATABASE_URL_UNPOOLED",
			"NEON_BRANCH",
			"NEON_DATA_API_URL",
		]);
	});
});

describe("ownedEnvServiceKeys", () => {
	it("never claims the AWS_* storage vars, which collide with user-set credentials", () => {
		expect(ownedEnvServiceKeys(["object-storage"])).toEqual([]);
	});

	it("claims the unambiguously Neon-named vars of the selected services", () => {
		expect(ownedEnvServiceKeys(["auth", "ai-gateway"])).toEqual([
			"NEON_AUTH_BASE_URL",
			"NEON_AUTH_JWKS_URL",
			"NEON_AI_GATEWAY_TOKEN",
			"NEON_AI_GATEWAY_BASE_URL",
		]);
	});
});

describe("unselectedSecretEnvKeys", () => {
	it("names the other half of the shared branch credential", () => {
		expect(unselectedSecretEnvKeys(["ai-gateway"])).toEqual([
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
		]);
		expect(unselectedSecretEnvKeys(["object-storage"])).toEqual([
			"NEON_AI_GATEWAY_TOKEN",
		]);
	});

	it("is empty when both credential-backed services are selected", () => {
		expect(
			unselectedSecretEnvKeys(["object-storage", "ai-gateway"]),
		).toEqual([]);
	});
});
