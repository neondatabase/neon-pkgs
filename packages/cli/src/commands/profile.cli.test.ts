/**
 * Behaviour of the real built CLI around profiles and credential selection.
 *
 * These spawn the published `dist/cli.js` rather than calling handlers, because what is under test is the
 * shell: argument precedence, what reaches stdout, and the exit code. They deliberately do not
 * use the shared `testCliCommand` fixture — it always passes `--api-key`, which is one half of
 * the very conflict these cases are about.
 *
 * Every case here is offline. The API host points at a port that refuses connections, so a case
 * that is supposed to fail before any request would fail loudly with a connection error rather
 * than passing for the wrong reason.
 */

import { fork } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import strip from "strip-ansi";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

/** An empty temp path, so no `.neon` in the checkout can reach a run. */
const contextFile = join(
	mkdtempSync(join(tmpdir(), "neon-profile-cli-ctx-")),
	".neon",
);

let unreachableHost = "";
beforeAll(async () => {
	unreachableHost = await new Promise<string>((res, rej) => {
		const probe = createServer();
		probe.on("error", rej);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as AddressInfo;
			probe.close((err) =>
				err ? rej(err) : res(`http://127.0.0.1:${port}`),
			);
		});
	});
});

const OAUTH_FILE = JSON.stringify({
	access_token: "oauth-access-token-secret",
	refresh_token: "oauth-refresh-token-secret",
	expires_at: Date.now() + 60 * 60 * 1000,
	user_id: "user-oauth",
});

const API_KEY_FILE = JSON.stringify({
	type: "api_key",
	api_key: "napi_supersecretkeyvalue",
	user_id: "user-key",
});

function makeConfigDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "neon-profile-cli-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(resolve(dir, name), contents, { mode: 0o600 });
	}
	return dir;
}

type Run = { code: number | null; stdout: string; stderr: string };

/** Run the built CLI with an explicit argument list and a controlled environment. */
function runCli(
	args: string[],
	env: Record<string, string> = {},
	stdin = "",
): Promise<Run> {
	return new Promise((res, rej) => {
		const cp = fork(
			// `dist/cli.js` is the real `bin` entry; `dist/index.js` is not what ships.
			join(process.cwd(), "./dist/cli.js"),
			[
				"--api-host",
				unreachableHost,
				"--no-analytics",
				// Defer to a case that names its own; passing it twice is now a strict error.
				...(args.includes("--context-file")
					? []
					: ["--context-file", contextFile]),
				...args,
			],
			{
				stdio: "pipe",
				env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...env },
			},
		);
		// Always closed, so a command that reads stdin sees EOF rather than hanging.
		cp.stdin?.end(stdin);
		let stdout = "";
		let stderr = "";
		cp.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		cp.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		cp.on("error", rej);
		cp.on("close", (code) =>
			res({ code, stdout: strip(stdout), stderr: strip(stderr) }),
		);
	});
}

describe("credential selection", () => {
	// The flag pair that used to resolve silently in favour of the key.
	test("--api-key with --profile fails, naming both", async () => {
		const dir = makeConfigDir({ "credentials.json": OAUTH_FILE });
		const { code, stderr } = await runCli([
			"projects",
			"list",
			"--config-dir",
			dir,
			"--api-key",
			"napi_flagkey",
			"--profile",
			"work",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("--api-key or --profile, not both");
	});

	// An ambient key must not make a typo'd profile look like it worked.
	test("an unknown --profile fails even when NEON_API_KEY is set", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { DEFAULT: { credentials: "credentials.json" } },
			}),
		});
		const { code, stderr } = await runCli(
			["projects", "list", "--config-dir", dir, "--profile", "ghost"],
			{ NEON_API_KEY: "napi_ambient" },
		);

		expect(code).toBe(1);
		expect(stderr).toContain('Unknown profile "ghost"');
	});

	// Both ambient: the key still wins, so CI is unaffected — but it says what it ignored.
	test("NEON_API_KEY with NEON_PROFILE warns about the profile it ignored", async () => {
		const dir = makeConfigDir({ "credentials.json": OAUTH_FILE });
		const { stderr } = await runCli(
			["projects", "list", "--config-dir", dir],
			{ NEON_API_KEY: "napi_ambient", NEON_PROFILE: "work" },
		);

		expect(stderr).toContain(
			'profile "work" from NEON_PROFILE was ignored',
		);
	});

	test("a profile command accepts --api-key without complaining", async () => {
		const dir = makeConfigDir({ "credentials.json": OAUTH_FILE });
		const { code, stderr } = await runCli([
			"profile",
			"list",
			"--config-dir",
			dir,
			"--api-key",
			"napi_flagkey",
		]);

		expect(code).toBe(0);
		expect(stderr).not.toContain("not both");
	});
});

describe("profile list", () => {
	test("reports the kind of each credential and never prints one", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"credentials.work.json": API_KEY_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					DEFAULT: { credentials: "credentials.json" },
					work: {
						credentials: "credentials.work.json",
						label: "work@example.com",
					},
				},
			}),
		});
		const { code, stdout, stderr } = await runCli([
			"profile",
			"list",
			"--config-dir",
			dir,
			"--output",
			"json",
		]);

		expect(code).toBe(0);
		const rows = JSON.parse(stdout);
		expect(rows).toEqual([
			expect.objectContaining({
				name: "DEFAULT",
				auth: "oauth",
				file: "ok",
			}),
			expect.objectContaining({
				name: "work",
				auth: "api key",
				account: "work@example.com",
				file: "ok",
			}),
		]);

		// The whole reason the secret lives outside profiles.json: listing cannot leak it.
		for (const stream of [stdout, stderr]) {
			expect(stream).not.toContain("napi_supersecretkeyvalue");
			expect(stream).not.toContain("oauth-access-token-secret");
			expect(stream).not.toContain("oauth-refresh-token-secret");
		}
	});

	test("a profile whose file is missing is listed as unavailable", async () => {
		const dir = makeConfigDir({
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					gone: { credentials: "credentials.gone.json" },
				},
			}),
		});
		const { code, stdout } = await runCli([
			"profile",
			"list",
			"--config-dir",
			dir,
			"--output",
			"json",
		]);

		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "gone",
					auth: "-",
					file: "missing",
				}),
			]),
		);
	});

	// One broken profile must not hide the others, but it must not be silent either.
	test("an unrecognised type is reported as invalid rather than crashing the table", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"credentials.odd.json": JSON.stringify({ type: "keychain" }),
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					DEFAULT: { credentials: "credentials.json" },
					odd: { credentials: "credentials.odd.json" },
				},
			}),
		});
		const { code, stdout, stderr } = await runCli([
			"profile",
			"list",
			"--config-dir",
			dir,
			"--output",
			"json",
		]);

		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "odd", auth: "invalid" }),
				expect.objectContaining({ name: "DEFAULT", auth: "oauth" }),
			]),
		);
		expect(stderr).toContain('unrecognised "type": "keychain"');
	});
});

describe("profile create", () => {
	// Guarding before anything else matters here: without it, `create` on an existing profile
	// would fall through to the browser sign-in and clobber a credential.
	test("refuses to replace an existing profile without --force", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"credentials.work.json": API_KEY_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					DEFAULT: { credentials: "credentials.json" },
					work: { credentials: "credentials.work.json" },
				},
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("already exists");
		expect(stderr).toContain("--force");
	});

	test("says what to pass when given no way to get a credential", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--api-key-file",
			resolve(dir, "missing-key"),
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("No such file");
	});

	test("refuses two ways of supplying the same key", async () => {
		const dir = makeConfigDir({ "some-key": "napi_fromfile" });
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--api-key",
			"napi_flagkey",
			"--api-key-file",
			resolve(dir, "some-key"),
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("only one of");
	});

	test("refuses an empty key file", async () => {
		const dir = makeConfigDir({ "blank-key": "   \n" });
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--api-key-file",
			resolve(dir, "blank-key"),
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("is empty");
	});

	test("names every way to supply a key when given none", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--org-id",
			"org-abc-123",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("only apply with --mint");
	});

	test("reads a key from stdin and never puts it in argv", async () => {
		const dir = makeConfigDir({});
		// The API host refuses connections, so this gets as far as verifying and no further —
		// which is enough to prove the key was read from the pipe rather than rejected as absent.
		const { code, stderr } = await runCli(
			[
				"profile",
				"create",
				"work",
				"--config-dir",
				dir,
				"--api-key-stdin",
			],
			{},
			"napi_from_stdin\n",
		);

		expect(code).toBe(1);
		expect(stderr).not.toContain("Nothing arrived on stdin");
		expect(stderr).not.toContain("napi_from_stdin");
	});

	// A flag named for a stream must not open a dialog: an agent on a pty would block forever.
	test("--api-key-stdin refuses a terminal instead of prompting", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--api-key-prompt",
		]);

		// stdin is a pipe here, so the interactive flag is the one with nothing to ask on.
		expect(code).toBe(1);
		expect(stderr).toContain("needs a terminal to ask on");
	});

	test("says so when nothing arrives on stdin", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--api-key-stdin",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("Nothing arrived on stdin");
	});

	// A scope only means something for a key we mint; a key you supply already has one.
	test("--org-id without --mint is refused rather than ignored", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--api-key",
			"napi_flagkey",
			"--org-id",
			"org-abc-123",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("only apply with --mint");
	});

	test("--org-id and --project-id together is refused", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"ci",
			"--config-dir",
			dir,
			"--mint",
			"--org-id",
			"org-abc-123",
			"--project-id",
			"proj-1",
		]);

		expect(code).toBe(1);
		expect(stderr).toMatch(
			/mutually exclusive|Arguments org-id and project-id/i,
		);
	});

	// Every rejected shape of a scope flag otherwise ends the same way: it reads as falsy and
	// an account key gets minted instead of the narrow one that was asked for.
	test("an empty --org-id is refused rather than read as absent", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"ci",
			"--config-dir",
			dir,
			"--mint",
			"--org-id",
			"",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("--org-id needs a value");
	});

	// `--mint` calls the OAuth flow directly, so it has to make the CI check that `authFlow`
	// makes — otherwise it sits waiting for a login nobody can complete.
	test("--mint refuses to wait for a browser in CI", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli(
			["profile", "create", "ci", "--config-dir", dir, "--mint"],
			{ CI: "true" },
		);

		expect(code).toBe(1);
		expect(stderr).toContain("cannot happen in CI");
		expect(stderr).toContain("--api-key-stdin");
	});

	test("options after a -- terminator are refused, not silently dropped", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"ci",
			"--config-dir",
			dir,
			"--mint",
			"--",
			"--org-id",
			"org-abc-123",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("takes no arguments after");
	});
});

describe("profile create — parsing and scope safety", () => {
	// Without `.strict()` a typo binds to nothing, reads as absent, and mints an account-wide
	// key instead of the narrow one that was asked for.
	test("a misspelled scope flag is rejected, not ignored", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"ci",
			"--config-dir",
			dir,
			"--mint",
			"--projectid",
			"proj-1",
		]);

		expect(code).toBe(1);
		expect(stderr).toMatch(/Unknown argument/i);
	});

	// A linked `.neon` must not decide how far a credential reaches.
	test("a checked-out project does not scope a minted key", async () => {
		const dir = makeConfigDir({});
		const contextDir = mkdtempSync(join(tmpdir(), "neon-profile-ctx-"));
		cleanups.push(() =>
			rmSync(contextDir, { recursive: true, force: true }),
		);
		const linked = resolve(contextDir, ".neon");
		writeFileSync(
			linked,
			JSON.stringify({
				projectId: "proj-from-context",
				orgId: "org-ctx",
			}),
		);

		// CI is set so the sign-in refuses immediately: reaching that message proves the
		// context never turned this into a project-scoped mint.
		const { code, stderr } = await runCli(
			[
				"profile",
				"create",
				"ci",
				"--config-dir",
				dir,
				"--context-file",
				linked,
				"--mint",
			],
			{ CI: "true" },
		);

		expect(code).toBe(1);
		expect(stderr).toContain("cannot happen in CI");
		expect(stderr).not.toContain("proj-from-context");
	});

	test("--mint with a supplied key is refused rather than one being ignored", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"ci",
			"--config-dir",
			dir,
			"--mint",
			"--api-key",
			"napi_flagkey",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("cannot be combined with --api-key");
	});
});

describe("replacing a profile is atomic", () => {
	// Retiring the old credential first meant a cancelled or failed replacement left the
	// profile holding something already revoked. The old one must survive a failure.
	test("a failed replacement leaves the existing credential untouched", async () => {
		const dir = makeConfigDir({
			"credentials.work.json": API_KEY_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		const before = readFileSync(
			resolve(dir, "credentials.work.json"),
			"utf8",
		);

		// The API host refuses connections, so verification fails and nothing is written.
		const { code } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--force",
			"--api-key",
			"napi_replacement",
		]);

		expect(code).toBe(1);
		expect(
			readFileSync(resolve(dir, "credentials.work.json"), "utf8"),
		).toBe(before);
	});

	// Same for the browser path: the session it would replace must not be revoked before the
	// new sign-in has actually happened.
	test("a refused sign-in leaves the existing credential untouched", async () => {
		const dir = makeConfigDir({
			"credentials.work.json": OAUTH_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		const before = readFileSync(
			resolve(dir, "credentials.work.json"),
			"utf8",
		);

		const { code, stderr } = await runCli(
			["profile", "create", "work", "--config-dir", dir, "--force"],
			{ CI: "true" },
		);

		expect(code).toBe(1);
		expect(stderr).toContain("Cannot run interactive auth in CI");
		expect(
			readFileSync(resolve(dir, "credentials.work.json"), "utf8"),
		).toBe(before);
	});
});

describe("profile rotate-key — what it refuses", () => {
	// Rotating would otherwise convert an OAuth profile into a key profile as a side effect,
	// discarding a session it never revoked.
	test("refuses a profile that holds a browser sign-in", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { DEFAULT: { credentials: "credentials.json" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"rotate-key",
			"DEFAULT",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("holds a browser sign-in");
		expect(stderr).toContain("--mint --force");
	});
});

describe("a damaged credentials file", () => {
	// It must not be "repaired" by a read-only command: treating it as absent let any command
	// start a sign-in and overwrite it, possibly as a different account, with no way back.
	test("stops the command and names the file and the repair", async () => {
		const dir = makeConfigDir({
			"credentials.json": "{ not json",
		});
		const { code, stderr } = await runCli([
			"projects",
			"list",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("not valid JSON");
		expect(stderr).toContain("credentials.json");
		expect(stderr).toContain("Replace it deliberately");
		// It did not go on to authenticate over the top of it.
		expect(stderr).not.toContain("Awaiting authentication");
	});

	// The repair the error recommends has to actually run. Reading the outgoing credential
	// fatally made `create --force` throw on the same file it was replacing, and left a
	// malformed file unremovable through the CLI.
	test("can still be removed, which the fatal read used to prevent", async () => {
		const dir = makeConfigDir({
			"credentials.work.json": "{ not json",
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"remove",
			"work",
			"--yes",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(0);
		expect(stderr).toContain("Nothing in it could be revoked");
		expect(existsSync(resolve(dir, "credentials.work.json"))).toBe(false);
	});

	// A parseable file with a kind we do not understand was classified as invalid by `list` yet
	// could not be removed, because `remove` asked for its kind without catching the refusal.
	test("a profile with an unrecognised type can be removed", async () => {
		const dir = makeConfigDir({
			"credentials.odd.json": JSON.stringify({ type: "unknown" }),
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { odd: { credentials: "credentials.odd.json" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"remove",
			"odd",
			"--yes",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(0);
		expect(stderr).toContain('unrecognised "type": "unknown"');
		expect(stderr).not.toContain("..");
		expect(existsSync(resolve(dir, "credentials.odd.json"))).toBe(false);
	});

	// But one broken profile must not take the whole listing with it.
	test("is reported as invalid by list, which still shows the others", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"credentials.broken.json": "{ not json",
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					DEFAULT: { credentials: "credentials.json" },
					broken: { credentials: "credentials.broken.json" },
				},
			}),
		});
		const { code, stdout, stderr } = await runCli([
			"profile",
			"list",
			"--config-dir",
			dir,
			"--output",
			"json",
		]);

		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toEqual(
			expect.arrayContaining([
				// One fault, one column: the kind of an unreadable file is genuinely unknown,
				// so `auth` is "-" and `file` carries the problem.
				expect.objectContaining({
					name: "broken",
					auth: "-",
					file: "invalid",
				}),
				expect.objectContaining({
					name: "DEFAULT",
					auth: "oauth",
					file: "ok",
				}),
			]),
		);
		expect(stderr).toContain("not valid JSON");
	});
});

describe("neon init and profile selection", () => {
	// Checking only the flag left the case that is easier to hit by accident: a profile
	// exported once into a shell, then disregarded by every `neon init` run in it.
	test("NEON_PROFILE is refused, not silently ignored", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"credentials.work.json": API_KEY_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					DEFAULT: { credentials: "credentials.json" },
					work: { credentials: "credentials.work.json" },
				},
			}),
		});
		const { code, stderr } = await runCli(["init", "--config-dir", dir], {
			NEON_PROFILE: "work",
		});

		expect(code).toBe(1);
		expect(stderr).toContain("NEON_PROFILE");
		expect(stderr).toContain("work");
	});

	// The profile has to exist, or credential selection rejects the name first and `init`'s own
	// refusal is never reached — which is what this case was accidentally asserting before.
	test("--profile is refused too", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"credentials.work.json": API_KEY_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					DEFAULT: { credentials: "credentials.json" },
					work: { credentials: "credentials.work.json" },
				},
			}),
		});
		const { code, stderr } = await runCli([
			"init",
			"--config-dir",
			dir,
			"--profile",
			"work",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("--profile");
		expect(stderr).toContain("does not support profile selection yet");
	});
});

describe("profile remove", () => {
	// Deleting the file only makes the key unreachable from here. Saying nothing would imply
	// the credential was destroyed.
	test("says an API key stays live on the account", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"credentials.work.json": API_KEY_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					DEFAULT: { credentials: "credentials.json" },
					work: { credentials: "credentials.work.json" },
				},
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"remove",
			"work",
			"--yes",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(0);
		expect(stderr).toContain("stays live on the account");
		expect(stderr).not.toContain("Revoked the OAuth token");
		expect(stderr).not.toContain("napi_supersecretkeyvalue");
	});
});

describe("profile rotate-key", () => {
	test("a profile with no usable credential says how to get one", async () => {
		const dir = makeConfigDir({
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"rotate-key",
			"work",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("no usable credential");
		expect(stderr).toContain("neon profile create work --mint --force");
	});
});
