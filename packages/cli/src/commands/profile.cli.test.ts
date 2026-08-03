/**
 * Behaviour of the real built CLI around profiles and credential selection.
 *
 * These spawn `dist/index.js` rather than calling handlers, because what is under test is the
 * shell: argument precedence, what reaches stdout, and the exit code. They deliberately do not
 * use the shared `testCliCommand` fixture — it always passes `--api-key`, which is one half of
 * the very conflict these cases are about.
 *
 * Every case here is offline. The API host points at a port that refuses connections, so a case
 * that is supposed to fail before any request would fail loudly with a connection error rather
 * than passing for the wrong reason.
 */

import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
): Promise<Run> {
	return new Promise((res, rej) => {
		const cp = fork(
			join(process.cwd(), "./dist/index.js"),
			["--api-host", unreachableHost, "--no-analytics", ...args],
			{
				stdio: "pipe",
				env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...env },
			},
		);
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
				available: "yes",
			}),
			expect.objectContaining({
				name: "work",
				auth: "api key",
				account: "work@example.com",
				available: "yes",
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
					available: "no",
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

describe("profile set-key", () => {
	// stdin is a pipe here, so there is no terminal to prompt on.
	test("with no key and no terminal it says what to pass instead of hanging", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"set-key",
			"work",
			"--config-dir",
			dir,
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("--api-key or --api-key-file");
	});

	test("refuses --api-key together with --api-key-file", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"set-key",
			"work",
			"--config-dir",
			dir,
			"--api-key",
			"napi_flagkey",
			"--api-key-file",
			resolve(dir, "somewhere"),
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("--api-key or --api-key-file, not both");
	});

	test("names a key file that is not there", async () => {
		const dir = makeConfigDir({});
		const { code, stderr } = await runCli([
			"profile",
			"set-key",
			"work",
			"--config-dir",
			dir,
			"--api-key-file",
			resolve(dir, "missing-key"),
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("No such file");
	});

	test("refuses an empty key file", async () => {
		const dir = makeConfigDir({ "blank-key": "   \n" });
		const { code, stderr } = await runCli([
			"profile",
			"set-key",
			"work",
			"--config-dir",
			dir,
			"--api-key-file",
			resolve(dir, "blank-key"),
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("is empty");
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

	test("--profile is refused too", async () => {
		const dir = makeConfigDir({ "credentials.json": OAUTH_FILE });
		const { code, stderr } = await runCli([
			"init",
			"--config-dir",
			dir,
			"--profile",
			"work",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("--profile");
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
		expect(stderr).toContain("neon auth --profile work");
	});
});
