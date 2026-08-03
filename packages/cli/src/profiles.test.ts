import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	DEFAULT_PROFILE,
	listProfiles,
	newProfileCredentialsPath,
	onlyDefaultRemains,
	readProfiles,
	removeProfileEntry,
	resolveProfile,
	selectProfileName,
	upsertProfile,
} from "./profiles.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
	vi.unstubAllEnvs();
});

function makeDir(files: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "neon-profiles-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	for (const [name, contents] of Object.entries(files)) {
		const path = resolve(root, name);
		mkdirSync(resolve(path, ".."), { recursive: true });
		writeFileSync(path, contents);
	}
	return root;
}

const creds = (who: string) => JSON.stringify({ access_token: who });

describe("selectProfileName", () => {
	test("flag wins over NEON_PROFILE wins over DEFAULT", () => {
		expect(selectProfileName("flag", { NEON_PROFILE: "env" })).toBe("flag");
		expect(selectProfileName(undefined, { NEON_PROFILE: "env" })).toBe(
			"env",
		);
		expect(selectProfileName(undefined, {})).toBe(DEFAULT_PROFILE);
	});

	test("whitespace-only values are treated as unset", () => {
		expect(selectProfileName("  ", { NEON_PROFILE: "  " })).toBe(
			DEFAULT_PROFILE,
		);
	});
});

describe("resolveProfile", () => {
	// The single-account case: no profiles.json at all, and everything still works.
	test("DEFAULT resolves to credentials.json with no profiles file", () => {
		const dir = makeDir({ "credentials.json": creds("me") });
		const p = resolveProfile(dir, DEFAULT_PROFILE);
		expect(p.credentialsPath).toBe(resolve(dir, "credentials.json"));
		expect(p.declared).toBe(false);
	});

	test("a declared profile resolves through its pointer", () => {
		const dir = makeDir({
			"credentials.json": creds("me"),
			"credentials.work.json": creds("work"),
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
		const p = resolveProfile(dir, "work");
		expect(p.credentialsPath).toBe(resolve(dir, "credentials.work.json"));
		expect(p.label).toBe("work@example.com");
		expect(p.declared).toBe(true);
	});

	// The property that makes adopting an existing config dir a one-line edit.
	test("a pointer may escape the config directory", () => {
		const outside = makeDir({ "credentials.json": creds("adopted") });
		const dir = makeDir({
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					other: { credentials: `${outside}/credentials.json` },
				},
			}),
		});
		expect(resolveProfile(dir, "other").credentialsPath).toBe(
			resolve(outside, "credentials.json"),
		);
	});

	test("an unknown name throws and names the known profiles", () => {
		const dir = makeDir({
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { DEFAULT: { credentials: "credentials.json" } },
			}),
		});
		expect(() => resolveProfile(dir, "nope")).toThrow(
			/Unknown profile "nope"/,
		);
		expect(() => resolveProfile(dir, "nope")).toThrow(/DEFAULT/);
	});

	test("DEFAULT still works when profiles.json omits it", () => {
		const dir = makeDir({
			"credentials.json": creds("me"),
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		expect(resolveProfile(dir, DEFAULT_PROFILE).credentialsPath).toBe(
			resolve(dir, "credentials.json"),
		);
	});

	// A broken profiles.json must not lock the user out of `neon auth`.
	test("a malformed profiles.json is ignored rather than fatal", () => {
		const dir = makeDir({
			"credentials.json": creds("me"),
			"profiles.json": "not json",
		});
		expect(readProfiles(dir)).toBeNull();
		expect(resolveProfile(dir, DEFAULT_PROFILE).credentialsPath).toBe(
			resolve(dir, "credentials.json"),
		);
	});
});

describe("upsertProfile", () => {
	test("creates profiles.json lazily and pins DEFAULT explicitly", () => {
		const dir = makeDir({ "credentials.json": creds("me") });
		upsertProfile(dir, "work", {
			credentials: newProfileCredentialsPath(dir, "work"),
			label: "work@example.com",
		});

		const file = JSON.parse(
			readFileSync(resolve(dir, "profiles.json"), "utf8"),
		);
		expect(file.profiles.DEFAULT.credentials).toBe("credentials.json");
		expect(file.profiles.work.credentials).toBe("credentials.work.json");
		expect(file.profiles.work.label).toBe("work@example.com");
	});

	test("stores paths relative to profiles.json, and keeps outside paths absolute", () => {
		const outside = makeDir({ "credentials.json": creds("adopted") });
		const dir = makeDir({ "credentials.json": creds("me") });
		upsertProfile(dir, "other", {
			credentials: resolve(outside, "credentials.json"),
		});
		const file = JSON.parse(
			readFileSync(resolve(dir, "profiles.json"), "utf8"),
		);
		// Relative is fine as long as it resolves back to the same file.
		expect(resolveProfile(dir, "other").credentialsPath).toBe(
			resolve(outside, "credentials.json"),
		);
		expect(file.profiles.other.credentials).toBeTruthy();
	});

	test("rejects a name that would escape the filename", () => {
		const dir = makeDir({});
		expect(() =>
			upsertProfile(dir, "../evil", { credentials: "x" }),
		).toThrow(/Invalid profile name/);
	});

	test("writes profiles.json owner-only", () => {
		const dir = makeDir({ "credentials.json": creds("me") });
		upsertProfile(dir, "work", { credentials: "credentials.work.json" });
		const { mode } = require("node:fs").statSync(
			resolve(dir, "profiles.json"),
		);
		expect(mode & 0o777).toBe(0o600);
	});
});

describe("removeProfileEntry / onlyDefaultRemains", () => {
	test("removes an entry and reports when only DEFAULT is left", () => {
		const dir = makeDir({ "credentials.json": creds("me") });
		upsertProfile(dir, "work", { credentials: "credentials.work.json" });

		expect(removeProfileEntry(dir, "work")).toBe(true);
		const file = readProfiles(dir);
		expect(file).not.toBeNull();
		expect(onlyDefaultRemains(file!)).toBe(true);
	});

	test("returns false for an entry that isn't there", () => {
		const dir = makeDir({ "credentials.json": creds("me") });
		expect(removeProfileEntry(dir, "ghost")).toBe(false);
	});
});

describe("listProfiles", () => {
	test("reports the implicit DEFAULT when there is no profiles.json", () => {
		const dir = makeDir({ "credentials.json": creds("me") });
		const all = listProfiles(dir);
		expect(all.map((p) => p.name)).toEqual([DEFAULT_PROFILE]);
	});

	test("always includes DEFAULT even when profiles.json omits it", () => {
		const dir = makeDir({
			"credentials.json": creds("me"),
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		expect(
			listProfiles(dir)
				.map((p) => p.name)
				.sort(),
		).toEqual(["DEFAULT", "work"]);
	});
});
