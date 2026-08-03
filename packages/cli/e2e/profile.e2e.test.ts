/**
 * Live coverage for API-key profiles: storing a real key, authenticating from it, and the
 * precedence rules — all against the real Neon API.
 *
 * The unit tests prove the decisions and the built-CLI tests prove the messages, but neither can
 * prove the API accepts what we stored or that `getAuthDetails` reports what we branch on. Only
 * a real key can.
 *
 * Every case here is scope-independent. The harness key may be organization-scoped, and an
 * organization key gets `404 not allowed for organization API keys` from `GET /users/me` — so
 * these use `projects list` rather than `me`, and never assume an email is available.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireApiKey } from "@neon/e2e-harness";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { e2eTest, runCli } from "./helpers.js";

const PROFILE = "e2e";

let configDir = "";
beforeAll(() => {
	configDir = mkdtempSync(join(tmpdir(), "neon-e2e-profile-"));
});
afterAll(() => {
	rmSync(configDir, { recursive: true, force: true });
});

describe("API-key profiles against the live API", () => {
	e2eTest("set-key stores a verified key the API accepts", async () => {
		const stored = await runCli(["profile", "set-key", PROFILE], {
			configDir,
			json: false,
		});
		expect(stored.stderr).toContain(
			`Stored an API key for profile "${PROFILE}"`,
		);
		expect(stored.code).toBe(0);

		// The key belongs in the credentials file, declared as one, and never in profiles.json.
		const credentials = JSON.parse(
			readFileSync(
				resolve(configDir, `credentials.${PROFILE}.json`),
				"utf8",
			),
		);
		expect(credentials.type).toBe("api_key");
		expect(credentials.api_key).toBe(requireApiKey());

		const profiles = readFileSync(
			resolve(configDir, "profiles.json"),
			"utf8",
		);
		expect(profiles).not.toContain(requireApiKey());

		const listed = await runCli(["profile", "list"], { configDir });
		expect(listed.code).toBe(0);
		const rows = JSON.parse(listed.stdout) as Array<{
			name: string;
			account: string;
		}>;
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: PROFILE,
					auth: "api key",
					available: "yes",
				}),
			]),
		);
		// Whoever the key belongs to, `set-key` resolved an identity from the API rather than
		// leaving a placeholder: a user key gets an email or id, an org key "organization <id>".
		expect(rows.find((r) => r.name === PROFILE)?.account).not.toBe("-");
		expect(listed.stdout).not.toContain(requireApiKey());
	});

	e2eTest(
		"a stored key authenticates with no key in the environment",
		async () => {
			const result = await runCli(["projects", "list"], {
				configDir,
				profile: PROFILE,
				env: { NEON_API_KEY: undefined, NEON_PROFILE: undefined },
			});

			expect(result.code).toBe(0);
			expect(() => JSON.parse(result.stdout)).not.toThrow();
		},
	);

	// The bug this feature exists to fix, proven against the real API: before, the bogus ambient
	// key would have won and the request would have failed with a 401.
	e2eTest("an explicit --profile beats a bogus NEON_API_KEY", async () => {
		const result = await runCli(["projects", "list"], {
			configDir,
			profile: PROFILE,
			env: { NEON_API_KEY: "napi_bogus_ambient_key" },
		});

		expect(result.code).toBe(0);
		expect(() => JSON.parse(result.stdout)).not.toThrow();
	});

	e2eTest(
		"a real key together with --profile is refused, not silently preferred",
		async () => {
			const result = await runCli(["projects", "list"], {
				configDir,
				profile: PROFILE,
				apiKey: requireApiKey(),
				json: false,
			});

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("--api-key or --profile, not both");
		},
	);

	// Verifying before storing is what makes a profile trustworthy: a key that cannot
	// authenticate never reaches disk, so `profile list` can't show an account that isn't real.
	e2eTest(
		"set-key refuses a key the API rejects, and writes nothing",
		async () => {
			const deadDir = mkdtempSync(
				join(tmpdir(), "neon-e2e-profile-dead-"),
			);
			try {
				const stored = await runCli(["profile", "set-key", "dead"], {
					configDir: deadDir,
					apiKey: "napi_definitely_not_a_real_key",
					json: false,
				});

				expect(stored.code).toBe(1);
				expect(stored.stderr).toMatch(
					/authentication failed|rejected/i,
				);
				expect(() =>
					readFileSync(
						resolve(deadDir, "credentials.dead.json"),
						"utf8",
					),
				).toThrow();
				expect(() =>
					readFileSync(resolve(deadDir, "profiles.json"), "utf8"),
				).toThrow();
			} finally {
				rmSync(deadDir, { recursive: true, force: true });
			}
		},
	);
});
