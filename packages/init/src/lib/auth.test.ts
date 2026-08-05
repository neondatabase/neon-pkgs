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
