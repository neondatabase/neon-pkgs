import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	assertProfilesUsable,
	canDropProfilesFile,
	DEFAULT_PROFILE,
	KEYRING_CREDENTIALS,
	listProfiles,
	locationOf,
	newProfileCredentialsPath,
	onlyDefaultRemains,
	readProfiles,
	removeProfileEntry,
	resolveProfile,
	selectProfileName,
	upsertProfile,
} from "@neon-internals/cli-core/profiles";
import { afterEach, describe, expect, test, vi } from "vitest";

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
		expect(p.storage).toBe("file");
		if (p.storage !== "file") throw new Error("expected file profile");
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
		expect(p.storage).toBe("file");
		if (p.storage !== "file") throw new Error("expected file profile");
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
		const adopted = resolveProfile(dir, "other");
		expect(adopted.storage).toBe("file");
		if (adopted.storage !== "file")
			throw new Error("expected file profile");
		expect(adopted.credentialsPath).toBe(
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

	test("the keyring sentinel is not resolved as a relative path", () => {
		const dir = makeDir({
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					DEFAULT: { credentials: KEYRING_CREDENTIALS },
				},
			}),
		});
		const p = resolveProfile(dir, DEFAULT_PROFILE);
		expect(p).toEqual({
			name: DEFAULT_PROFILE,
			storage: "keyring",
			declared: true,
		});
	});

	test("DEFAULT still works when profiles.json omits it", () => {
		const dir = makeDir({
			"credentials.json": creds("me"),
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "credentials.work.json" } },
			}),
		});
		const p = resolveProfile(dir, DEFAULT_PROFILE);
		expect(p.storage).toBe("file");
		if (p.storage !== "file") throw new Error("expected file profile");
		expect(p.credentialsPath).toBe(resolve(dir, "credentials.json"));
	});

	// A malformed file may be DEFAULT's only keyring pointer, so OAuth cannot replace it.
	test("a malformed profiles.json blocks DEFAULT", () => {
		const dir = makeDir({
			"credentials.json": creds("me"),
			"profiles.json": "not json",
		});
		expect(readProfiles(dir)).toBeNull();
		expect(() => resolveProfile(dir, DEFAULT_PROFILE)).toThrow(
			/could not be read as a profiles file/,
		);
		expect(() => assertProfilesUsable(dir, DEFAULT_PROFILE)).toThrow(
			/could not be read as a profiles file/,
		);
	});

	// But a *named* profile is defined only in that file, so "not found" is the wrong answer:
	// the user is looking at an entry the CLI is claiming does not exist.
	test("a named profile reports the broken file, not an unknown profile", () => {
		const dir = makeDir({
			"credentials.json": creds("me"),
			"profiles.json": "not json",
		});
		expect(() => resolveProfile(dir, "work")).toThrow(
			/could not be read as a profiles file/,
		);
		expect(() => resolveProfile(dir, "work")).not.toThrow(
			/Unknown profile/,
		);
	});

	test.each([
		["not an object", '"just a string"', /does not contain an object/],
		["no profiles key", '{"version":1}', /has no `profiles` object/],
		[
			"an invalid profile name",
			'{"version":1,"profiles":{"bad name":{"credentials":"c.json"}}}',
			/"bad name" is not a valid profile name/,
		],
		[
			"an entry with no pointer",
			'{"version":1,"profiles":{"work":{"label":"me"}}}',
			/profile "work" has no `credentials` pointer/,
		],
	])("%s is refused with the reason", (_label, contents, expected) => {
		const dir = makeDir({
			"credentials.json": creds("me"),
			"profiles.json": contents,
		});
		expect(() => resolveProfile(dir, "work")).toThrow(expected);
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
		const relocated = resolveProfile(dir, "other");
		expect(relocated.storage).toBe("file");
		if (relocated.storage !== "file")
			throw new Error("expected file profile");
		expect(relocated.credentialsPath).toBe(
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

	// Reading tolerates a broken file; writing must not. Treating it as absent here rebuilt it
	// from a single DEFAULT entry, discarding every named profile in it — silent data loss in
	// the only record of where each account's credentials live. The credentials themselves
	// survive, so refusing keeps the file recoverable by hand.
	test("refuses to overwrite a malformed profiles.json, losing nothing", () => {
		const broken = '{"version":1,"profiles":{"work":{"credentials":';
		const dir = makeDir({
			"credentials.json": creds("me"),
			"profiles.json": broken,
		});

		expect(() =>
			upsertProfile(dir, "other", {
				credentials: "credentials.other.json",
			}),
		).toThrow(/Refusing to rewrite it/);
		expect(readFileSync(resolve(dir, "profiles.json"), "utf8")).toBe(
			broken,
		);
	});

	test("and refuses when an entry in it is unusable", () => {
		const dir = makeDir({
			"credentials.json": creds("me"),
			"profiles.json": '{"version":1,"profiles":{"work":{}}}',
		});
		expect(() =>
			upsertProfile(dir, "other", {
				credentials: "credentials.other.json",
			}),
		).toThrow(/has no `credentials` pointer/);
	});

	test("a file named keyring is stored as ./keyring, not the sentinel", () => {
		const dir = makeDir({ "credentials.json": creds("me") });
		const path = resolve(dir, "keyring");
		upsertProfile(dir, "work", { credentials: path });
		const file = JSON.parse(
			readFileSync(resolve(dir, "profiles.json"), "utf8"),
		);
		expect(file.profiles.work.credentials).toBe("./keyring");
		const p = resolveProfile(dir, "work");
		expect(p.storage).toBe("file");
		if (p.storage !== "file") throw new Error("expected file profile");
		expect(p.credentialsPath).toBe(path);
	});

	test("writes the keyring sentinel without resolving it as a path", () => {
		const dir = makeDir({ "credentials.json": creds("me") });
		upsertProfile(dir, DEFAULT_PROFILE, {
			credentials: KEYRING_CREDENTIALS,
		});
		const file = JSON.parse(
			readFileSync(resolve(dir, "profiles.json"), "utf8"),
		);
		expect(file.profiles.DEFAULT.credentials).toBe(KEYRING_CREDENTIALS);
		const p = resolveProfile(dir, DEFAULT_PROFILE);
		expect(p.storage).toBe("keyring");
		expect(locationOf(p)).toEqual({
			profile: DEFAULT_PROFILE,
			storage: "keyring",
		});
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
		expect(canDropProfilesFile(file!)).toBe(true);
	});

	test("does not drop profiles.json when DEFAULT is keyring", () => {
		const dir = makeDir({});
		upsertProfile(dir, DEFAULT_PROFILE, {
			credentials: KEYRING_CREDENTIALS,
		});
		upsertProfile(dir, "work", { credentials: "credentials.work.json" });
		expect(removeProfileEntry(dir, "work")).toBe(true);
		const file = readProfiles(dir);
		expect(file).not.toBeNull();
		expect(onlyDefaultRemains(file!)).toBe(true);
		expect(canDropProfilesFile(file!)).toBe(false);
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

describe("profile hosts", () => {
	const STAGE_API = "https://console-stage.example/api/v2";
	const STAGE_OAUTH = "https://oauth2-stage.example";
	const profilesFile = (dir: string) =>
		JSON.parse(readFileSync(resolve(dir, "profiles.json"), "utf8"));
	const withEntry = (entry: Record<string, unknown>, name = "stage") =>
		makeDir({
			"credentials.json": creds("me"),
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					DEFAULT: { credentials: "credentials.json" },
					[name]: { credentials: "credentials.stage.json", ...entry },
				},
			}),
		});

	test("a named profile resolves with the hosts it records", () => {
		const dir = withEntry({ apiHost: STAGE_API, oauthHost: STAGE_OAUTH });
		expect(resolveProfile(dir, "stage")).toMatchObject({
			apiHost: STAGE_API,
			oauthHost: STAGE_OAUTH,
		});
		expect(resolveProfile(dir, DEFAULT_PROFILE)).not.toHaveProperty(
			"apiHost",
		);
	});

	test.each([
		["not a URL", "console-stage.example"],
		["not http or https", "ftp://console-stage.example"],
		["not a string", 42],
	])("an apiHost that is %s makes the file unusable", (_label, apiHost) => {
		const dir = withEntry({ apiHost });
		expect(() => resolveProfile(dir, "stage")).toThrow(
			/profile "stage" has an invalid `apiHost`: expected an http or https URL/,
		);
	});

	test("DEFAULT cannot record a host", () => {
		const dir = makeDir({
			"credentials.json": creds("me"),
			"profiles.json": JSON.stringify({
				version: 1,
				profiles: {
					DEFAULT: {
						credentials: "credentials.json",
						oauthHost: STAGE_OAUTH,
					},
				},
			}),
		});
		expect(() => resolveProfile(dir, DEFAULT_PROFILE)).toThrow(
			/profile "DEFAULT" sets `oauthHost`, which only a named profile can/,
		);
	});

	test("upsert sets hosts, keeps them when omitted, and removes them on null", () => {
		const dir = makeDir({ "credentials.json": creds("me") });
		upsertProfile(dir, "stage", {
			credentials: "credentials.stage.json",
			apiHost: STAGE_API,
			oauthHost: STAGE_OAUTH,
		});
		expect(profilesFile(dir).profiles.stage).toMatchObject({
			apiHost: STAGE_API,
			oauthHost: STAGE_OAUTH,
		});

		upsertProfile(dir, "stage", {
			credentials: "credentials.stage.json",
			label: "again@example.com",
		});
		expect(profilesFile(dir).profiles.stage).toMatchObject({
			apiHost: STAGE_API,
			oauthHost: STAGE_OAUTH,
			label: "again@example.com",
		});

		upsertProfile(dir, "stage", {
			credentials: "credentials.stage.json",
			apiHost: null,
		});
		expect(profilesFile(dir).profiles.stage).toEqual({
			credentials: "credentials.stage.json",
			oauthHost: STAGE_OAUTH,
		});
	});

	test("upsert refuses a host on DEFAULT and a host that is not a URL", () => {
		const dir = makeDir({ "credentials.json": creds("me") });
		expect(() =>
			upsertProfile(dir, DEFAULT_PROFILE, {
				credentials: "credentials.json",
				apiHost: STAGE_API,
			}),
		).toThrow(/Profile "DEFAULT" cannot record an API or OAuth host/);
		expect(() =>
			upsertProfile(dir, "stage", {
				credentials: "credentials.stage.json",
				apiHost: "console-stage.example",
			}),
		).toThrow(/expected an http or https URL/);
		expect(readProfiles(dir)).toBeNull();
	});
});
