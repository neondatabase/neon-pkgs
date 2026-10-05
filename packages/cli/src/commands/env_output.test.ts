import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { displayPath, formatPulledEnv } from "./env_output.js";

const cwd = "/work/my-app";

describe("formatPulledEnv", () => {
	test("groups keys by service in canonical order and marks only freshly issued values", () => {
		const out = formatPulledEnv(
			{
				status: "written",
				file: "/work/my-app/.env.local",
				written: [
					"NEON_AI_GATEWAY_BASE_URL",
					"NEON_FUNCTION_WEBHOOK_BASE_URL",
					"AWS_REGION",
					"NEON_BRANCH",
					"DATABASE_URL_UNPOOLED",
					"NEON_FUNCTION_HELLO_BASE_URL",
					"AWS_ACCESS_KEY_ID",
					"DATABASE_URL",
					"NEON_AI_GATEWAY_TOKEN",
				],
				removed: ["NEON_AUTH_BASE_URL", "NEON_AUTH_JWKS_URL"],
				credential: {
					issued: true,
					keys: ["AWS_ACCESS_KEY_ID", "NEON_AI_GATEWAY_TOKEN"],
					fresh: ["NEON_AI_GATEWAY_TOKEN"],
					revoked: ["neon-env-old"],
					superseded: [],
				},
			},
			cwd,
		);
		expect(out).toBe(
			[
				"Pulled 9 Neon variables into .env.local",
				"  Postgres        DATABASE_URL, DATABASE_URL_UNPOOLED",
				"  Branch          NEON_BRANCH",
				"  Functions       NEON_FUNCTION_HELLO_BASE_URL, NEON_FUNCTION_WEBHOOK_BASE_URL",
				"  Object Storage  AWS_ACCESS_KEY_ID, AWS_REGION",
				"  AI Gateway      NEON_AI_GATEWAY_TOKEN*, NEON_AI_GATEWAY_BASE_URL",
				"  Removed         NEON_AUTH_BASE_URL, NEON_AUTH_JWKS_URL (not produced by this pull)",
				"  * new credential value",
				"Revoked the credential it replaced (neon-env-old).",
				"",
			].join("\n"),
		);
	});
});

describe("displayPath", () => {
	test("is relative inside cwd and absolute outside it", () => {
		expect(displayPath("/work/my-app/config/.neon", cwd)).toBe(
			"config/.neon",
		);
		expect(displayPath("/elsewhere/.neon", cwd)).toBe("/elsewhere/.neon");
		expect(displayPath(join(homedir(), "other", ".neon"), cwd)).toBe(
			"~/other/.neon",
		);
	});
});
