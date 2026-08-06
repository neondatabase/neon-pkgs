import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { isAuthenticated } from "./auth.js";

/**
 * `isAuthenticated` decides whether `neon init` starts a browser sign-in, and a sign-in
 * overwrites the credentials file — as a different account, if a different one is chosen. So
 * "not signed in" has to mean the file is *absent*, and nothing else.
 *
 * This reader is shared with `neon` and `@neon/env`; `packages/cli` covers it directly. What is
 * tested here is the decision this package makes with it, which had no coverage while a
 * catch-all returned `null` for every failure — an install with a damaged credential looked
 * identical to a fresh machine.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
	vi.unstubAllEnvs();
});

/** A config directory pointed at by `NEON_CONFIG_DIR`, optionally holding credentials. */
function makeConfigDir(credentials: string | null): string {
	const dir = mkdtempSync(join(tmpdir(), "neon-init-auth-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(dir, { recursive: true });
	if (credentials !== null) {
		writeFileSync(resolve(dir, "credentials.json"), credentials, {
			mode: 0o600,
		});
	}
	vi.stubEnv("NEON_CONFIG_DIR", dir);
	return dir;
}

describe("isAuthenticated", () => {
	test("no credentials file means not signed in", async () => {
		makeConfigDir(null);
		await expect(isAuthenticated()).resolves.toBe(false);
	});

	test("an OAuth session counts as signed in", async () => {
		makeConfigDir(JSON.stringify({ access_token: "at" }));
		await expect(isAuthenticated()).resolves.toBe(true);
	});

	// The reason the reader is shared at all: this package used to look only for
	// `access_token`, so an account signed in with an API key was sent to a browser.
	test("a stored API key counts as signed in", async () => {
		makeConfigDir(JSON.stringify({ type: "api_key", api_key: "napi_x" }));
		await expect(isAuthenticated()).resolves.toBe(true);
	});

	test("an OAuth file with no usable token is not signed in", async () => {
		makeConfigDir(JSON.stringify({ refresh_token: "rt-only" }));
		await expect(isAuthenticated()).resolves.toBe(false);
	});

	test("a damaged file is an error, not a fresh machine", async () => {
		makeConfigDir("{ not json");
		await expect(isAuthenticated()).rejects.toThrow(/not valid JSON/);
		await expect(isAuthenticated()).rejects.toThrow(
			/neon profile create DEFAULT --force/,
		);
	});

	// Whatever it says, it must not say what the file holds.
	test("and the error never quotes the file's contents", async () => {
		makeConfigDir('{"api_key":napi_SENTINELSECRET}');
		await expect(isAuthenticated()).rejects.toThrow(
			expect.objectContaining({
				message: expect.not.stringContaining("napi_"),
			}),
		);
	});

	test("a file declaring a key it does not have is an error", async () => {
		makeConfigDir(JSON.stringify({ type: "api_key" }));
		await expect(isAuthenticated()).rejects.toThrow(/no "api_key" value/);
	});
});

/**
 * Failing loudly is only half of it — the failure has to be shaped like the output the
 * caller asked for. An agent parses stdout and has no branch for "empty stdout, exit 1":
 * it cannot tell a damaged credentials file from a phase that produced nothing. So
 * `--agent` answers a thrown error with JSON on stdout, and a human gets one line on
 * stderr instead.
 */
describe("`neon init` failure output", () => {
	const CLI = resolve(import.meta.dirname, "..", "..", "dist", "cli.js");

	/** A credential the auth middleware accepts without touching the network. */
	const USABLE_CREDENTIALS = JSON.stringify({
		type: "api_key",
		api_key: "napi_test",
	});

	/** Run the built binary in a directory of its own, against the given credentials file. */
	function runInit(args: string[], credentials = USABLE_CREDENTIALS) {
		const configDir = mkdtempSync(join(tmpdir(), "neon-init-cli-cfg-"));
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-cli-cwd-"));
		cleanups.push(() =>
			rmSync(configDir, { recursive: true, force: true }),
		);
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		writeFileSync(resolve(configDir, "credentials.json"), credentials, {
			mode: 0o600,
		});
		const result = spawnSync(process.execPath, [CLI, "init", ...args], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				NEON_CONFIG_DIR: configDir,
				NEON_NO_ANALYTICS: "1",
			},
		});
		return { ...result, configDir };
	}

	test("--agent answers a malformed --data payload with JSON on stdout", () => {
		const { status, stdout } = runInit(["--agent", "--data", "{not json"]);

		expect(status).toBe(1);
		const parsed = JSON.parse(stdout);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toMatch(/Invalid JSON in --data flag/);
		expect(parsed.error).toContain("{not json");
	});

	test("one JSON object per invocation, and no log prefix on it", () => {
		const { stdout } = runInit(["--agent", "--data", "{not json"]);

		expect(() => JSON.parse(stdout)).not.toThrow();
		expect(stdout.match(/"success"/g)).toHaveLength(1);
		// Routing this through `log` would have prefixed it and put it on stderr.
		expect(stdout).not.toMatch(/^(INFO|ERROR|WARNING):/m);
	});

	test("--agent answers the profile refusal with JSON on stdout", () => {
		const { status, stdout } = runInit(["--agent", "--profile", "DEFAULT"]);

		expect(status).toBe(1);
		const parsed = JSON.parse(stdout);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toMatch(/does not support profile selection/);
	});

	// The human half of the same failure: one line on stderr, nothing on stdout, and no
	// help screen. `--profile` is the refusal that fails before any prompting, so this
	// exercises the non-agent path without needing a TTY.
	test("without --agent it is one stderr line, not a help dump", () => {
		const { status, stdout, stderr } = runInit(["--profile", "DEFAULT"]);

		expect(status).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("ERROR: ");
		expect(stderr).toMatch(/does not support profile selection/);
		expect(stderr).not.toContain("Show help");
		expect(stderr).not.toMatch(/^\s*at /m);
	});

	// A damaged credentials file is caught by the auth middleware, which reads credentials
	// before the `init` skip in `ensureAuth` — so it never reaches the handler and never
	// takes the JSON path, even under `--agent`. It must still fail loudly and say why.
	test("a damaged credential is reported before the handler runs, and says what to do", () => {
		const { status, stdout, stderr } = runInit(
			["--agent", "--data", '{"step":"status"}'],
			"{ not json",
		);

		expect(status).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toMatch(/not valid JSON/);
		expect(stderr).toMatch(/neon profile create DEFAULT --force/);
		expect(stderr).not.toContain("Show help");
		expect(stderr).not.toMatch(/^\s*at /m);
	});

	test("and the report never quotes the credential file's contents", () => {
		const { stdout, stderr } = runInit(
			["--agent", "--data", '{"step":"status"}'],
			'{"api_key":napi_SENTINELSECRET}',
		);

		expect(stdout + stderr).not.toContain("napi_");
	});
});
