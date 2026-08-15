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

	// The mirror image of the flag pair above, and the half that was left silent: `--api-key`
	// is global, so `.strict()` cannot see it, and these three commands took it, ignored it,
	// and acted on the stored credential instead. On `remove` that produced a revoke failure
	// against a credential the user had not passed.
	test.each([
		["list", []],
		["rotate-key", ["work"]],
		["remove", ["work", "--yes"]],
	])("profile %s refuses --api-key rather than ignoring it", async (sub, rest) => {
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
			sub,
			...rest,
			"--config-dir",
			dir,
			"--api-key",
			"napi_flagkey",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain(
			`--api-key does not apply to \`profile ${sub}\``,
		);
		// Refused for its own reason, not routed through the flag-pair conflict.
		expect(stderr).not.toContain("not both");
		// Nothing was removed on the way to refusing.
		expect(existsSync(resolve(dir, "credentials.work.json"))).toBe(true);
	});

	// `create` is the one that stores a key, so the flag has to keep working there.
	test("profile create still takes --api-key", async () => {
		const dir = makeConfigDir({});
		const { stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--api-key",
			"napi_flagkey",
		]);

		expect(stderr).not.toContain("does not apply");
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
				storage: "file",
			}),
			expect.objectContaining({
				name: "work",
				auth: "api key",
				account: "work@example.com",
				file: "ok",
				storage: "file",
			}),
		]);

		// The whole reason the secret lives outside profiles.json: listing cannot leak it.
		for (const stream of [stdout, stderr]) {
			expect(stream).not.toContain("napi_supersecretkeyvalue");
			expect(stream).not.toContain("oauth-access-token-secret");
			expect(stream).not.toContain("oauth-refresh-token-secret");
		}
	});

	test("a keyring pointer lists storage as keyring and file as unreadable", async () => {
		const dir = makeConfigDir({
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { DEFAULT: { credentials: "keyring" } },
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
				expect.objectContaining({
					name: "DEFAULT",
					auth: "-",
					file: "unreadable",
					storage: "keyring",
					credentials: "keyring",
				}),
			]),
		);
		expect(stderr).toMatch(
			/neon auth --profile DEFAULT|neon profile remove DEFAULT --yes/,
		);
	});

	test("projects list does not start OAuth when a keyring pointer is unread", async () => {
		const dir = makeConfigDir({
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { DEFAULT: { credentials: "keyring" } },
			}),
		});
		const { code, stderr } = await runCli(
			["projects", "list", "--config-dir", dir],
			{ CI: "true" },
		);

		expect(code).toBe(1);
		expect(stderr).toMatch(/OS keyring/);
		expect(stderr).not.toContain("Cannot run interactive auth in CI");
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
					storage: "file",
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
				// One column answers "can this be used". Reporting `file: "ok"` beside `auth:
				// "invalid"` sent anyone scanning for the broken profile to a different row.
				expect.objectContaining({
					name: "odd",
					auth: "invalid",
					file: "invalid",
				}),
				expect.objectContaining({
					name: "DEFAULT",
					auth: "oauth",
					file: "ok",
				}),
			]),
		);
		expect(stderr).toContain(
			'declares a "type" this version does not understand',
		);
		// The one credential error that used to be a dead end: it throws before the reader
		// that appends a repair, so it had to grow its own.
		expect(stderr).toContain("`neon profile create odd --force`");
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

	// What `--force` costs, before it is paid. Replacing a profile revokes the credential it
	// holds, so a key this CLI minted dies wherever else it was pasted — and the message that
	// said "replace its credential" described a local edit, which is the half a user would
	// have agreed to.
	test("says the key --force revokes, and names it", async () => {
		const dir = makeConfigDir({
			"credentials.work.json": JSON.stringify({
				type: "api_key",
				api_key: "napi_minted_here",
				key_id: 4242,
			}),
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--api-key",
			"napi_replacement",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("id 4242");
		expect(stderr).toContain("the key is revoked");
		// The non-destructive alternative, since the user's goal is usually a working key.
		expect(stderr).toContain("neon profile rotate-key work");
	});

	// A key we did not mint records no id, so it survives the replacement. Claiming otherwise
	// in either direction is the problem: this one is warned about at `remove` too.
	test("says a supplied key stays live either way", async () => {
		const dir = makeConfigDir({
			"credentials.work.json": API_KEY_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--api-key",
			"napi_replacement",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("stays live on the account either way");
	});

	test("says the session --force replaces is signed out", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { DEFAULT: { credentials: "credentials.json" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"DEFAULT",
			"--config-dir",
			dir,
			"--api-key",
			"napi_replacement",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("holds a browser sign-in");
		expect(stderr).toContain("signed out as part of the replacement");
	});

	test("create --keyring on a file OAuth profile names auth --keyring", async () => {
		const dir = makeConfigDir({
			"credentials.work.json": OAUTH_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--keyring",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("holds a browser sign-in");
		expect(stderr).toContain("neon auth --keyring --profile work");
		expect(existsSync(resolve(dir, "credentials.work.json"))).toBe(true);
	});

	test("create --no-keyring on a keyring pointer names remove", async () => {
		const dir = makeConfigDir({
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "keyring" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--no-keyring",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("--no-keyring does not move");
		expect(stderr).toContain("neon profile remove work --yes");
	});

	// The no-flag form is what an agent tries first, and `authFlow` answered it with a bare
	// "Cannot run interactive auth in CI" — true, and with no way forward from it.
	test("a keyring pointer is an existing profile even when the item is unread", async () => {
		const dir = makeConfigDir({
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { DEFAULT: { credentials: "keyring" } },
			}),
		});
		const { code, stderr } = await runCli(
			["profile", "create", "DEFAULT", "--config-dir", dir],
			{ CI: "true" },
		);

		expect(code).toBe(1);
		expect(stderr).toContain("already exists");
		expect(stderr).toContain("--force");
		expect(stderr).not.toContain("cannot happen in CI");
	});

	test("with no key in CI, says how to pass one instead", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli(
			["profile", "create", "ci", "--config-dir", dir],
			{ CI: "true" },
		);

		expect(code).toBe(1);
		expect(stderr).toContain("cannot happen in CI");
		expect(stderr).toContain('neon profile create ci --api-key "$KEY"');
		expect(stderr).toContain("--api-key -");
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

	// `-` is the usual convention for a piped value, and it means the key never reaches argv
	// where `ps` and shell history can see it. It needs `nargs` on the option, or yargs reads
	// the dash as an option of its own and reports "Unknown command: -".
	test("--api-key - reads the key from stdin", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli(
			[
				"profile",
				"create",
				"work",
				"--config-dir",
				dir,
				"--api-key",
				"-",
			],
			{},
			"napi_from_stdin\n",
		);

		// The API host refuses connections, so this gets as far as verifying and no further —
		// enough to show the dash was replaced by what was piped rather than sent as a key.
		expect(code).toBe(1);
		expect(stderr).not.toContain("Unknown command");
		expect(stderr).not.toContain("Nothing arrived on stdin");
		expect(stderr).not.toContain("napi_from_stdin");
	});

	// The dash needs `nargs` on *both* the global option and this command's override. With it
	// only on the override, yargs read the dash as a command of its own here and answered
	// "Unknown commands: -, create, work".
	test("--api-key - works before the command too", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli(
			[
				"--api-key",
				"-",
				"profile",
				"create",
				"work",
				"--config-dir",
				dir,
			],
			{},
			"napi_from_stdin\n",
		);

		// The API host refuses connections, so this gets as far as verifying and no further —
		// enough to show the dash bound and was replaced by what was piped.
		expect(code).toBe(1);
		expect(stderr).not.toContain("Unknown command");
		expect(stderr).not.toContain("Nothing arrived on stdin");
		expect(stderr).not.toContain("napi_from_stdin");
	});

	// `nargs` must not break an ordinary value in the same position.
	test("a real key before the command still binds", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"--api-key",
			"napi_ordinary",
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).not.toContain("Unknown command");
		expect(stderr).not.toContain("Nothing to store");
	});

	test("--api-key=- works the same way", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli(
			["profile", "create", "work", "--config-dir", dir, "--api-key=-"],
			{},
			"napi_from_stdin\n",
		);

		expect(code).toBe(1);
		expect(stderr).not.toContain("Nothing arrived on stdin");
	});

	test("says so when the pipe is empty", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--api-key",
			"-",
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
		expect(stderr).toContain("--api-key -");
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
		expect(stderr).toContain("cannot happen in CI");
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

	// The repair has to be runnable as printed. It named a literal `<name>`, which an agent
	// runs verbatim and is told `Invalid profile name "<name>"` for.
	test("the repair names the profile that points at the file", async () => {
		const dir = makeConfigDir({
			"credentials.work.json": "{ not json",
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		const { code, stderr } = await runCli([
			"projects",
			"list",
			"--config-dir",
			dir,
			"--profile",
			"work",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("`neon profile create work --force`");
		expect(stderr).not.toContain("<name>");
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
		expect(stderr).toContain(
			'declares a "type" this version does not understand',
		);
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

describe("a credentials file that declares a key it does not have", () => {
	// `credentialKind` answers what the file *declares*, and `{ "type": "api_key" }` declares a
	// key. Using that as validation made `list` report a working API-key profile, and sent
	// `remove` into `getApiClient` with `undefined` behind an `as string` — a revoke request
	// authenticated by nothing, reported to the user as a failed revocation.
	test("is listed as invalid, not as a working api key", async () => {
		const dir = makeConfigDir({
			"credentials.hollow.json": JSON.stringify({ type: "api_key" }),
			"credentials.blank.json": JSON.stringify({
				type: "api_key",
				api_key: "   ",
			}),
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					hollow: { credentials: "credentials.hollow.json" },
					blank: { credentials: "credentials.blank.json" },
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
				expect.objectContaining({
					name: "hollow",
					auth: "invalid",
					file: "invalid",
				}),
				expect.objectContaining({
					name: "blank",
					auth: "invalid",
					file: "invalid",
				}),
			]),
		);
		expect(stderr).toContain('no "api_key" value');
	});

	test("is removable, and no revocation is attempted", async () => {
		const dir = makeConfigDir({
			"credentials.hollow.json": JSON.stringify({
				type: "api_key",
				key_id: 99,
			}),
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					hollow: { credentials: "credentials.hollow.json" },
				},
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"remove",
			"hollow",
			"--yes",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(0);
		expect(stderr).toContain("Nothing in it could be revoked");
		// The API host refuses connections, so an attempted revoke would say so out loud.
		expect(stderr).not.toContain("Could not revoke");
		expect(stderr).not.toContain("id 99");
		expect(existsSync(resolve(dir, "credentials.hollow.json"))).toBe(false);
	});
});

describe("a malformed profiles.json", () => {
	const BROKEN = "{ not json";

	// Refusing at the write was too late. With the metadata unreadable, `credentials.work.json`
	// is a *guess* about which account that file holds — and `create` acted on the guess:
	// overwrote it, revoked the key it replaced, and only then reached `upsertProfile`'s
	// refusal. The earlier version of this case missed it, because a fake key fails
	// verification against the unreachable API before any write happens.
	//
	// So the assertion is ordering: the refusal must arrive *before* the network call that a
	// wrong answer would otherwise reach first.
	test("stops a named create before it touches a credentials file", async () => {
		const sentinel = JSON.stringify({
			type: "api_key",
			api_key: "napi_sentinel_do_not_touch",
			key_id: 777,
		});
		const dir = makeConfigDir({
			"profiles.json": BROKEN,
			"credentials.work.json": sentinel,
		});
		const { code, stderr } = await runCli([
			"profile",
			"create",
			"work",
			"--force",
			"--config-dir",
			dir,
			"--api-key",
			"napi_replacement",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("could not be read as a profiles file");
		// The proof it happened first: the unreachable API was never called.
		expect(stderr).not.toContain("Could not reach the Neon API");
		expect(
			readFileSync(resolve(dir, "credentials.work.json"), "utf8"),
		).toBe(sentinel);
		expect(readFileSync(resolve(dir, "profiles.json"), "utf8")).toBe(
			BROKEN,
		);
	});

	// `neon auth --profile work` is the other way in, and it opened the browser first.
	test("stops a named sign-in before the browser opens", async () => {
		const sentinel = JSON.stringify({ access_token: "sentinel-token" });
		const dir = makeConfigDir({
			"profiles.json": BROKEN,
			"credentials.work.json": sentinel,
		});
		const { code, stderr } = await runCli([
			"auth",
			"--profile",
			"work",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("could not be read as a profiles file");
		expect(stderr).not.toContain("Awaiting authentication");
		expect(
			readFileSync(resolve(dir, "credentials.work.json"), "utf8"),
		).toBe(sentinel);
	});

	test("blocks a DEFAULT sign-in", async () => {
		const dir = makeConfigDir({ "profiles.json": BROKEN });
		const { code, stderr } = await runCli(["auth", "--config-dir", dir], {
			CI: "true",
		});

		expect(code).toBe(1);
		expect(stderr).toContain("could not be read as a profiles file");
		expect(stderr).not.toContain("Cannot run interactive auth in CI");
		expect(stderr).not.toContain("Awaiting authentication");
	});

	// It is the only record of where each account's credentials live, and `create` used to
	// rebuild it from a single DEFAULT entry when it could not be read — silent data loss.
	// `upsertProfile`'s refusal is unit-tested in `profiles.test.ts`; what this adds is that
	// the binary leaves the file alone.
	test("survives a create attempt byte for byte", async () => {
		const dir = makeConfigDir({ "profiles.json": BROKEN });
		const { code } = await runCli([
			"profile",
			"create",
			"work",
			"--config-dir",
			dir,
			"--api-key",
			"napi_whatever",
		]);

		expect(code).toBe(1);
		expect(readFileSync(resolve(dir, "profiles.json"), "utf8")).toBe(
			BROKEN,
		);
	});

	// "Unknown profile" names the wrong problem: the user can see the profile in the file.
	test("is reported as broken rather than as an unknown profile", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"profiles.json": BROKEN,
		});
		const { code, stderr } = await runCli([
			"projects",
			"list",
			"--config-dir",
			dir,
			"--profile",
			"work",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("could not be read as a profiles file");
		expect(stderr).not.toContain('Unknown profile "work"');
	});

	// `list` is the command run to find out what is there, so it must not answer "one profile".
	test("stops list rather than silently showing only DEFAULT", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"profiles.json": BROKEN,
		});
		const { code, stdout, stderr } = await runCli([
			"profile",
			"list",
			"--config-dir",
			dir,
			"--output",
			"json",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("could not be read as a profiles file");
		expect(stdout).not.toContain("DEFAULT");
	});

	// A name this CLI would refuse to create cannot be trusted on the way back in: it becomes
	// part of a filename and of the recovery command printed in every error about that profile.
	test("an invalid profile name in the file is refused", async () => {
		const dir = makeConfigDir({
			"credentials.json": OAUTH_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { "bad name": { credentials: "credentials.json" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"list",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).toContain('"bad name" is not a valid profile name');
	});

	test("an entry with no credentials path is refused", async () => {
		const dir = makeConfigDir({
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { label: "me@example.com" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"list",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).toContain('profile "work" has no `credentials` pointer');
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
		expect(stderr).toContain("does not support profile selection yet");
		// Both spellings of "how this profile got selected" have to read as English. The
		// flag branch was a bare "--profile", so the sentence started with no verb:
		// "--profile `neon init` would run as the default account instead of …".
		expect(stderr).toContain(
			"--profile was passed, so `neon init` would run",
		);
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

	// Guarded on `isCi()` alone, this was the shape a pipeline actually produces — stdin held
	// by a pipe, `CI` unset — and `prompts` drew a question nobody could answer. At EOF it
	// resolved to nothing and the process exited **0** having removed the profile it named,
	// which an agent reads as success. Every other prompt in the CLI checks both.
	//
	// `runCli` always closes stdin, so this is that case without arranging anything.
	test("refuses to prompt when stdin is not a terminal", async () => {
		const dir = makeConfigDir({
			"credentials.work.json": API_KEY_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			"remove",
			"work",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("stdin is not a terminal");
		expect(stderr).toContain("--yes");
		// The half that made exiting 0 dangerous: it really was still there.
		expect(existsSync(resolve(dir, "credentials.work.json"))).toBe(true);
		expect(readFileSync(resolve(dir, "profiles.json"), "utf8")).toContain(
			"work",
		);
	});

	// Same guard, reached the other way. Kept as its own case because CI is where an
	// unattended run is most likely to be reading the exit code and nothing else.
	test("refuses to prompt in CI", async () => {
		const dir = makeConfigDir({
			"credentials.work.json": API_KEY_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		const { code, stderr } = await runCli(
			["profile", "remove", "work", "--config-dir", dir],
			{ CI: "true" },
		);

		expect(code).toBe(1);
		expect(stderr).toContain("Pass --yes");
		expect(existsSync(resolve(dir, "credentials.work.json"))).toBe(true);
	});

	test("an unread keyring profile is removed and warns about a leftover", async () => {
		const dir = makeConfigDir({
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "keyring" } },
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
		expect(stderr).toMatch(
			/leftover may still be in the OS store|cannot delete the OS keyring item/i,
		);
		expect(stderr).toContain("com.neon.neon-cli");
		expect(stderr).not.toContain("neon auth --profile work");
		expect(existsSync(resolve(dir, "profiles.json"))).toBe(false);
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

describe("profile commands that do not exist", () => {
	test("profile storage is not a command", async () => {
		const dir = makeConfigDir({
			"credentials.json": API_KEY_FILE,
		});
		const { code, stderr } = await runCli([
			"profile",
			"storage",
			"--config-dir",
			dir,
		]);
		expect(code).toBe(1);
		expect(stderr).not.toContain("credStorage");
		expect(existsSync(resolve(dir, "credentials.json"))).toBe(true);
	});

	test("profile mv is not a command", async () => {
		const dir = makeConfigDir({
			"credentials.json": API_KEY_FILE,
		});
		const { code, stderr } = await runCli([
			"profile",
			"mv",
			"--config-dir",
			dir,
		]);
		expect(code).toBe(1);
		expect(stderr).toMatch(/Unknown (argument|command)/i);
		expect(existsSync(resolve(dir, "credentials.json"))).toBe(true);
	});
});

describe("--api-key skips stored credential config", () => {
	test("an invalid config.json does not break --api-key", async () => {
		const dir = makeConfigDir({
			"config.json": '{"credStorage":napi_LEAKED',
		});
		const { code, stderr } = await runCli([
			"me",
			"--config-dir",
			dir,
			"--api-key",
			"napi_flag_only",
		]);
		// The host is unreachable, so the command fails after auth — not while
		// parsing config.json. The leaked fragment must not appear.
		expect(stderr).not.toContain("napi_LEAKED");
		expect(stderr).not.toContain("not valid JSON");
		expect(code).not.toBe(0);
	});
});

describe("--profile on a subcommand that takes a name", () => {
	// The suggestion this used to make was built from the flag rather than the positional, so
	// it renamed the target: `remove work --profile other` answered "did you mean `neon
	// profile remove other`". The name is a required positional, so that was wrong every time
	// it fired — and on `remove` it was copy-pasteable destructive advice for an account the
	// user had never mentioned.
	test.each([
		"create",
		"rotate-key",
		"remove",
	])("profile %s names both values and suggests nothing", async (sub) => {
		const dir = makeConfigDir({
			"credentials.work.json": API_KEY_FILE,
			"credentials.other.json": API_KEY_FILE,
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					work: { credentials: "credentials.work.json" },
					other: { credentials: "credentials.other.json" },
				},
			}),
		});
		const { code, stderr } = await runCli([
			"profile",
			sub,
			"work",
			"--config-dir",
			dir,
			"--profile",
			"other",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain('You passed both "work" and --profile other');
		expect(stderr).toContain("drop --profile");
		expect(stderr).not.toContain("Did you mean");
		// Nothing was acted on, least of all the profile named only by the flag.
		expect(existsSync(resolve(dir, "credentials.other.json"))).toBe(true);
	});
});
