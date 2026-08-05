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

import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
	e2eTest(
		"create --api-key stores a verified key the API accepts",
		async () => {
			const stored = await runCli(["profile", "create", PROFILE], {
				configDir,
				json: false,
			});
			expect(stored.stderr).toContain(
				`Profile "${PROFILE}" now holds api key`,
			);
			// The caveat about a supplied key is a warning, not a note: it is the same one
			// `api-keys create` raises at that level.
			expect(stored.stderr).toContain("cannot be revoked by");
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

			// No `--api-key`: `list` reads files, and refuses a key rather than ignoring one.
			const listed = await runCli(["profile", "list"], {
				configDir,
				apiKey: null,
			});
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
						file: "ok",
						// Scope-independent on purpose. The harness key may be user- or
						// organization-scoped, and pinning one of them made this pass locally
						// on a personal key and fail in CI on an organization key. What matters
						// is that a key always reports some reach, never the "-" an OAuth
						// session gets.
						scope: expect.stringMatching(
							/^(account|org .+|project .+)$/,
						),
					}),
				]),
			);
			// Whoever the key belongs to, `create` resolved an identity from the API rather than
			// leaving a placeholder: a user key gets an email or id, an org key "organization <id>".
			expect(rows.find((r) => r.name === PROFILE)?.account).not.toBe("-");
			expect(listed.stdout).not.toContain(requireApiKey());
		},
	);

	// An agent that creates a profile should not have to run `profile list` to find out what it
	// just made — and the record must not carry the secret.
	e2eTest("create reports the profile as JSON, without the key", async () => {
		const jsonDir = mkdtempSync(join(tmpdir(), "neon-e2e-profile-json-"));
		try {
			const created = await runCli(["profile", "create", "agent"], {
				configDir: jsonDir,
				apiKey: requireApiKey(),
			});

			expect(created.code).toBe(0);
			expect(JSON.parse(created.stdout)).toEqual(
				expect.objectContaining({
					name: "agent",
					auth: "api key",
					scope: expect.any(String),
					credentials: expect.stringContaining(
						"credentials.agent.json",
					),
				}),
			);
			expect(created.stdout).not.toContain(requireApiKey());
		} finally {
			rmSync(jsonDir, { recursive: true, force: true });
		}
	});

	// The ordering that stops a credential being orphaned: the credential is written first, so a
	// failure recording the profile costs a label rather than stranding a live key whose id has
	// already been overwritten. Reached without a fault hook, by making the config directory
	// read-only while the credentials file it points at stays writable.
	e2eTest(
		"a failure recording the profile still leaves the credential written",
		async () => {
			const readOnlyDir = mkdtempSync(join(tmpdir(), "neon-e2e-ro-"));
			const adoptedDir = mkdtempSync(join(tmpdir(), "neon-e2e-adopted-"));
			const adopted = resolve(adoptedDir, "credentials.locked.json");
			try {
				// A supplied key with no `key_id`, so nothing is revoked when it is replaced.
				writeFileSync(
					adopted,
					JSON.stringify({
						type: "api_key",
						api_key: "napi_placeholder_not_a_real_key",
					}),
					{ mode: 0o600 },
				);
				writeFileSync(
					resolve(readOnlyDir, "profiles.json"),
					JSON.stringify({
						version: 1,
						profiles: { locked: { credentials: adopted } },
					}),
					{ mode: 0o600 },
				);
				chmodSync(readOnlyDir, 0o500);

				const result = await runCli(
					["profile", "create", "locked", "--force"],
					{
						configDir: readOnlyDir,
						apiKey: requireApiKey(),
						json: false,
					},
				);

				// `profiles.json` could not be rewritten, so the command fails …
				expect(result.code).toBe(1);
				// … but the credential itself was already committed, which is the whole point of
				// writing it before the metadata.
				expect(JSON.parse(readFileSync(adopted, "utf8")).api_key).toBe(
					requireApiKey(),
				);
			} finally {
				chmodSync(readOnlyDir, 0o700);
				rmSync(readOnlyDir, { recursive: true, force: true });
				rmSync(adoptedDir, { recursive: true, force: true });
			}
		},
	);

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
		"create refuses a key the API rejects, and writes nothing",
		async () => {
			const deadDir = mkdtempSync(
				join(tmpdir(), "neon-e2e-profile-dead-"),
			);
			try {
				const stored = await runCli(["profile", "create", "dead"], {
					configDir: deadDir,
					apiKey: "napi_definitely_not_a_real_key",
					json: false,
				});

				expect(stored.code).toBe(1);
				// `profile` skips `ensureAuth`, so nothing records how the call authenticated
				// and the top-level handler used to answer with "Check --api-key or
				// NEON_API_KEY" — while this command's own help says it ignores
				// `NEON_API_KEY`. An agent reads that and exports the variable to no effect.
				expect(stored.stderr).toContain(
					"The Neon API rejected the key passed to --api-key",
				);
				expect(stored.stderr).not.toContain("NEON_API_KEY");
				expect(stored.stderr).toContain("--mint");
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

	// Live, because a real key is the case that matters: the helper passes one on every call by
	// default, so a subcommand quietly accepting it here is exactly how the flag came to be
	// dropped in the first place.
	e2eTest(
		"profile list refuses a real key rather than using it",
		async () => {
			const result = await runCli(["profile", "list"], {
				configDir,
				apiKey: requireApiKey(),
				json: false,
			});

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				"--api-key does not apply to `profile list`",
			);
		},
	);

	// `profile create --mint --project-id` resolves the owning organization through the same
	// `orgIdForProject` this exercises, rather than a second copy of the lookup — a copy is
	// how the identical typo came to get a written explanation from `api-keys create` and a
	// raw 404 from `profile create`. Reached through `api-keys` because the mint path needs a
	// browser sign-in first; the lookup and its message are the shared part.
	e2eTest(
		"an organization id in the project slot is explained, not 404'd",
		async () => {
			const result = await runCli(
				[
					"api-keys",
					"create",
					"--name",
					"never-created",
					"--project-id",
					"org-not-a-project-id",
				],
				{ json: false },
			);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				"That looks like an organization id",
			);
			expect(result.stderr).toContain("--org-id");
			// The lookup happens before anything is created, so the refusal costs nothing.
			expect(result.stderr).not.toContain("napi_");
		},
	);
});
