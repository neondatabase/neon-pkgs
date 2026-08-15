import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type AuthContext,
	authFailureMessage,
	credentialsToClearOn401,
} from "./auth_context.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function makeDir(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

describe("credentialsToClearOn401", () => {
	test("clears an expired OAuth session the CLI created", () => {
		const dir = makeDir("neon-ctx-");
		const path = resolve(dir, "credentials.work.json");
		const context: AuthContext = {
			source: "stored-credentials",
			configDir: dir,
			profile: "work",
			credentialsPath: path,
		};
		expect(credentialsToClearOn401(context)).toEqual({
			profile: "work",
			storage: "file",
			path,
		});
	});

	// The bug this exists for: the handler had only the config directory, so a rejected token
	// on a --profile-selected account cleared whatever DEFAULT pointed at.
	test("clears the selected profile's file, not DEFAULT's", () => {
		const dir = makeDir("neon-ctx-");
		const selected = resolve(dir, "credentials.work.json");
		expect(
			credentialsToClearOn401({
				source: "stored-credentials",
				configDir: dir,
				profile: "work",
				credentialsPath: selected,
			}),
		).not.toBe(resolve(dir, "credentials.json"));
	});

	// A profile may point anywhere. `profile remove` refuses to delete an adopted file, so a
	// 401 must not quietly do what an explicit removal declines to.
	test("leaves an adopted file outside the config directory alone", () => {
		const configDir = makeDir("neon-ctx-");
		const elsewhere = makeDir("neon-adopted-");
		expect(
			credentialsToClearOn401({
				source: "stored-credentials",
				configDir,
				profile: "adopted",
				credentialsPath: resolve(elsewhere, "credentials.json"),
			}),
		).toBeNull();
	});

	// Not a sibling-directory prefix match: `<dir>-other` must not count as inside `<dir>`.
	test("a directory that merely shares a prefix is outside", () => {
		const configDir = "/home/me/.config/neon";
		expect(
			credentialsToClearOn401({
				source: "stored-credentials",
				configDir,
				credentialsPath: "/home/me/.config/neon-other/credentials.json",
			}),
		).toBeNull();
	});

	// Unlike an OAuth token there is nothing to refresh, so deleting would destroy the only
	// copy of a credential the user has to paste or mint again.
	test("never clears an API key", () => {
		const dir = makeDir("neon-ctx-");
		expect(
			credentialsToClearOn401({
				source: "profile-api-key",
				configDir: dir,
				profile: "work",
				credentialsPath: resolve(dir, "credentials.work.json"),
			}),
		).toBeNull();
	});

	test("does not clear a keyring OAuth session", () => {
		expect(
			credentialsToClearOn401({
				source: "stored-credentials",
				configDir: "/c",
				profile: "work",
				storage: "keyring",
			}),
		).toBeNull();
	});

	test("never clears anything for a key the user supplied", () => {
		expect(
			credentialsToClearOn401({
				source: "api-key",
				configDir: "/anywhere",
			}),
		).toBeNull();
	});

	test("no context clears nothing", () => {
		expect(credentialsToClearOn401(null)).toBeNull();
	});
});

describe("authFailureMessage", () => {
	test("a profile key names the profile, the file, and how to replace it", () => {
		const message = authFailureMessage({
			source: "profile-api-key",
			configDir: "/c",
			profile: "dbx",
			credentialsPath: "/c/credentials.dbx.json",
		});
		expect(message).toContain('profile "dbx"');
		expect(message).toContain("/c/credentials.dbx.json");
		// Not `rotate-key`: a rejected key cannot authenticate to mint its own replacement.
		expect(message).toContain("neon profile create dbx --mint --force");
		expect(message).not.toContain("rotate-key");
	});

	// "Check --api-key" would be nonsense for a session we declined to delete.
	test("a keyring session says to sign in again and does not mention a file", () => {
		const message = authFailureMessage({
			source: "stored-credentials",
			configDir: "/c",
			profile: "work",
			storage: "keyring",
		});
		expect(message).toContain("OS keyring");
		expect(message).toContain("neon auth --profile work");
		expect(message).not.toContain("file was not created");
		expect(message).not.toContain("--api-key");
	});

	test("a keyring DEFAULT session pins --profile DEFAULT", () => {
		const message = authFailureMessage({
			source: "stored-credentials",
			configDir: "/c",
			profile: "DEFAULT",
			storage: "keyring",
		});
		expect(message).toContain("neon auth --profile DEFAULT");
	});

	test("an adopted session says to sign in again, not to check a flag", () => {
		const message = authFailureMessage({
			source: "stored-credentials",
			configDir: "/c",
			profile: "adopted",
			credentialsPath: "/elsewhere/credentials.json",
		});
		expect(message).toContain("neon auth --profile adopted");
		expect(message).not.toContain("--api-key");
	});

	test("a supplied key points at where it came from", () => {
		expect(
			authFailureMessage({ source: "api-key", configDir: "/c" }),
		).toContain("NEON_API_KEY");
	});
});
