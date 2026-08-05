import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveApiKey } from "./resolve-api-key.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

/**
 * A temp home containing `.config/<dirName>/credentials.json`.
 *
 * Defaults to the legacy `neonctl` directory: every existing test below was written against
 * it, so their continuing to pass is the backward-compatibility check.
 */
function makeHome(
	credentials: string | null,
	dirName: "neon" | "neonctl" = "neonctl",
): string {
	const root = mkdtempSync(join(tmpdir(), "neon-env-apikey-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const dir = resolve(root, ".config", dirName);
	mkdirSync(dir, { recursive: true });
	if (credentials !== null) {
		writeFileSync(resolve(dir, "credentials.json"), credentials);
	}
	return root;
}

const token = (access_token: string) => JSON.stringify({ access_token });

describe("resolveApiKey — precedence", () => {
	test("flag wins over env wins over stored credentials", () => {
		const home = makeHome(token("from-file"));
		const env = { HOME: home, NEON_API_KEY: "from-env" };

		expect(resolveApiKey({ apiKey: "from-flag", env })).toBe("from-flag");
		expect(resolveApiKey({ env })).toBe("from-env");
		expect(resolveApiKey({ env: { HOME: home } })).toBe("from-file");
	});

	test("honours NEONCTL_CONFIG_DIR over the default location", () => {
		const home = makeHome(token("default-loc"));
		const custom = mkdtempSync(join(tmpdir(), "neon-env-cfg-"));
		cleanups.push(() => rmSync(custom, { recursive: true, force: true }));
		writeFileSync(
			resolve(custom, "credentials.json"),
			token("from-env-dir"),
		);

		expect(
			resolveApiKey({ env: { HOME: home, NEONCTL_CONFIG_DIR: custom } }),
		).toBe("from-env-dir");
	});

	test("falls back to USERPROFILE on Windows-style env", () => {
		const home = makeHome(token("win-token"));
		expect(resolveApiKey({ env: { USERPROFILE: home } })).toBe("win-token");
	});

	// The config directory is `neon`; `neonctl` is the pre-rename name, still read so an
	// existing install keeps working. Every other test here seeds the legacy directory.
	test("reads the current .config/neon directory", () => {
		const home = makeHome(token("from-neon"), "neon");
		expect(resolveApiKey({ env: { HOME: home } })).toBe("from-neon");
	});

	test("prefers .config/neon over the legacy .config/neonctl", () => {
		const home = makeHome(token("from-neonctl"), "neonctl");
		const currentDir = resolve(home, ".config", "neon");
		mkdirSync(currentDir, { recursive: true });
		writeFileSync(
			resolve(currentDir, "credentials.json"),
			token("from-neon"),
		);
		expect(resolveApiKey({ env: { HOME: home } })).toBe("from-neon");
	});

	// This is the divergence the shared resolver fixes: `neon` honoured XDG_CONFIG_HOME
	// while this package didn't, so with it set the two looked in different places.
	test("honours XDG_CONFIG_HOME, matching the neon CLI", () => {
		const xdg = mkdtempSync(join(tmpdir(), "neon-env-xdg-"));
		cleanups.push(() => rmSync(xdg, { recursive: true, force: true }));
		const dir = resolve(xdg, "neon");
		mkdirSync(dir, { recursive: true });
		writeFileSync(resolve(dir, "credentials.json"), token("from-xdg"));

		const home = makeHome(token("from-home"));
		expect(
			resolveApiKey({ env: { HOME: home, XDG_CONFIG_HOME: xdg } }),
		).toBe("from-xdg");
	});

	test("NEON_CONFIG_DIR wins over NEONCTL_CONFIG_DIR", () => {
		const legacyVar = mkdtempSync(join(tmpdir(), "neon-env-legacyvar-"));
		const currentVar = mkdtempSync(join(tmpdir(), "neon-env-currentvar-"));
		cleanups.push(() =>
			rmSync(legacyVar, { recursive: true, force: true }),
		);
		cleanups.push(() =>
			rmSync(currentVar, { recursive: true, force: true }),
		);
		writeFileSync(
			resolve(legacyVar, "credentials.json"),
			token("legacy-var"),
		);
		writeFileSync(
			resolve(currentVar, "credentials.json"),
			token("current-var"),
		);

		expect(
			resolveApiKey({
				env: {
					NEONCTL_CONFIG_DIR: legacyVar,
					NEON_CONFIG_DIR: currentVar,
				},
			}),
		).toBe("current-var");
	});

	test("treats whitespace-only flag and env as missing", () => {
		const home = makeHome(token("from-file"));
		expect(
			resolveApiKey({
				apiKey: "   ",
				env: { HOME: home, NEON_API_KEY: "  " },
			}),
		).toBe("from-file");
	});

	test("trims the resolved value", () => {
		expect(resolveApiKey({ apiKey: "  napi_x  ", env: {} })).toBe("napi_x");
	});
});

describe("resolveApiKey — returns undefined rather than throwing", () => {
	test("no source provides a key", () => {
		const home = makeHome(null);
		expect(resolveApiKey({ env: { HOME: home } })).toBeUndefined();
	});

	test("no home directory resolvable", () => {
		expect(resolveApiKey({ env: {} })).toBeUndefined();
	});

	test("malformed JSON", () => {
		const home = makeHome("not json");
		expect(resolveApiKey({ env: { HOME: home } })).toBeUndefined();
	});

	test("credentials file has no access_token, or an empty one", () => {
		const noToken = makeHome(JSON.stringify({ refresh_token: "rt-only" }));
		expect(resolveApiKey({ env: { HOME: noToken } })).toBeUndefined();

		const emptyToken = makeHome(token(""));
		expect(resolveApiKey({ env: { HOME: emptyToken } })).toBeUndefined();
	});

	test("credentials file is a JSON array, not an object", () => {
		const home = makeHome("[]");
		expect(resolveApiKey({ env: { HOME: home } })).toBeUndefined();
	});
});

/**
 * The credentials file holds one of two kinds and `type` says which. Reading only
 * `access_token` reported "no key" for an account that is perfectly signed in with a key.
 */
describe("resolveApiKey — an api_key credentials file", () => {
	const apiKeyFile = (api_key: string, extra: object = {}) =>
		JSON.stringify({ type: "api_key", api_key, ...extra });

	test("its api_key is used", () => {
		const home = makeHome(apiKeyFile("napi_stored"));
		expect(resolveApiKey({ env: { HOME: home } })).toBe("napi_stored");
	});

	test("in the current `neon` directory too", () => {
		const home = makeHome(apiKeyFile("napi_stored"), "neon");
		expect(resolveApiKey({ env: { HOME: home } })).toBe("napi_stored");
	});

	// `type` decides, not which fields are present — a minted key keeps the OAuth token set it
	// was minted from, and that token must not win over the key the file declares.
	test("the api_key wins over a retained access_token", () => {
		const home = makeHome(
			apiKeyFile("napi_stored", { access_token: "retained-oauth" }),
		);
		expect(resolveApiKey({ env: { HOME: home } })).toBe("napi_stored");
	});

	test("an explicit flag and NEON_API_KEY still outrank it", () => {
		const home = makeHome(apiKeyFile("napi_stored"));
		expect(
			resolveApiKey({ apiKey: "from-flag", env: { HOME: home } }),
		).toBe("from-flag");
		expect(
			resolveApiKey({ env: { HOME: home, NEON_API_KEY: "from-env" } }),
		).toBe("from-env");
	});

	test("an api_key file with no key is no key, not a fall back to access_token", () => {
		const home = makeHome(
			JSON.stringify({ type: "api_key", access_token: "oauth-token" }),
		);
		expect(resolveApiKey({ env: { HOME: home } })).toBeUndefined();
	});
});

/**
 * The reader is shared with the `neon` CLI now, so `neon --profile dbx env` and `neon-env`
 * resolve the same account. Before this, `neon-env` read `DEFAULT` only and the two could
 * silently disagree.
 */
describe("resolveApiKey — profiles", () => {
	const apiKeyFile = (api_key: string) =>
		JSON.stringify({ type: "api_key", api_key });

	function makeProfiles(
		files: Record<string, string>,
		profiles: Record<string, { credentials: string }>,
	): string {
		const root = mkdtempSync(join(tmpdir(), "neon-env-profiles-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const dir = resolve(root, ".config", "neon");
		mkdirSync(dir, { recursive: true });
		for (const [name, contents] of Object.entries(files)) {
			writeFileSync(resolve(dir, name), contents);
		}
		writeFileSync(
			resolve(dir, "profiles.json"),
			JSON.stringify({ version: 1, profiles }),
		);
		return root;
	}

	test("NEON_PROFILE selects a profile's key", () => {
		const home = makeProfiles(
			{
				"credentials.json": apiKeyFile("napi_default"),
				"credentials.work.json": apiKeyFile("napi_work"),
			},
			{
				DEFAULT: { credentials: "credentials.json" },
				work: { credentials: "credentials.work.json" },
			},
		);
		expect(
			resolveApiKey({ env: { HOME: home, NEON_PROFILE: "work" } }),
		).toBe("napi_work");
	});

	test("an explicit profile wins over NEON_PROFILE", () => {
		const home = makeProfiles(
			{
				"credentials.json": apiKeyFile("napi_default"),
				"credentials.work.json": apiKeyFile("napi_work"),
			},
			{
				DEFAULT: { credentials: "credentials.json" },
				work: { credentials: "credentials.work.json" },
			},
		);
		expect(
			resolveApiKey({
				profile: "DEFAULT",
				env: { HOME: home, NEON_PROFILE: "work" },
			}),
		).toBe("napi_default");
	});

	// A profile the user named and that cannot be used is an error, not "no API key" —
	// reporting a missing credential would hide that the real problem is the name they typed.
	test("an unknown profile says so instead of reporting no key", () => {
		const home = makeProfiles(
			{ "credentials.json": apiKeyFile("napi_default") },
			{ DEFAULT: { credentials: "credentials.json" } },
		);
		expect(() =>
			resolveApiKey({ env: { HOME: home, NEON_PROFILE: "ghost" } }),
		).toThrow(/Unknown profile "ghost"/);
	});

	// DEFAULT is the exception: nothing was named, so an absent credential is the ordinary
	// not-signed-in case and the library's PLATFORM_MISSING_API_KEY reports it better.
	test("no credential under DEFAULT is simply no key", () => {
		const home = makeProfiles({}, {});
		expect(resolveApiKey({ env: { HOME: home } })).toBeUndefined();
	});

	// The bug this precedence exists to stop, in the package where it was reintroduced.
	test("an explicit --profile beats an ambient NEON_API_KEY", () => {
		const home = makeProfiles(
			{
				"credentials.json": apiKeyFile("napi_default"),
				"credentials.work.json": apiKeyFile("napi_work"),
			},
			{
				DEFAULT: { credentials: "credentials.json" },
				work: { credentials: "credentials.work.json" },
			},
		);
		expect(
			resolveApiKey({
				profile: "work",
				env: { HOME: home, NEON_API_KEY: "napi_ambient" },
			}),
		).toBe("napi_work");
	});

	test("both explicit flags is an error rather than a silent winner", () => {
		const home = makeProfiles(
			{ "credentials.json": apiKeyFile("napi_default") },
			{ DEFAULT: { credentials: "credentials.json" } },
		);
		expect(() =>
			resolveApiKey({
				apiKey: "from-flag",
				profile: "DEFAULT",
				env: { HOME: home },
			}),
		).toThrow(/--api-key or --profile, not both/);
	});

	test("an explicit key still outranks any profile", () => {
		const home = makeProfiles(
			{ "credentials.json": apiKeyFile("napi_default") },
			{ DEFAULT: { credentials: "credentials.json" } },
		);
		expect(
			resolveApiKey({
				apiKey: "from-flag",
				env: { HOME: home, NEON_PROFILE: "work" },
			}),
		).toBe("from-flag");
	});

	// Sharing the decision with `neon` was only half of it. Two ambient sources resolve to the
	// key — correct, and indistinguishable from having run as the profile unless it is said
	// out loud. `neon` has warned here from the start; this package returned the key in
	// silence, which is the original bug wearing a quieter coat.
	test("warns when an exported key displaces an exported profile", () => {
		const home = makeProfiles(
			{
				"credentials.json": apiKeyFile("napi_default"),
				"credentials.work.json": apiKeyFile("napi_work"),
			},
			{
				DEFAULT: { credentials: "credentials.json" },
				work: { credentials: "credentials.work.json" },
			},
		);
		const warnings: string[] = [];

		const key = resolveApiKey({
			env: {
				HOME: home,
				NEON_API_KEY: "napi_ambient",
				NEON_PROFILE: "work",
			},
			warn: (message) => warnings.push(message),
		});

		expect(key).toBe("napi_ambient");
		expect(warnings).toEqual([
			expect.stringContaining(
				'profile "work" from NEON_PROFILE was ignored',
			),
		]);
	});

	// Nothing was displaced in either of these, and a warning that fires when nothing happened
	// is noise a script has to learn to ignore.
	test.each([
		["only a profile is exported", { NEON_PROFILE: "work" }],
		["only a key is exported", { NEON_API_KEY: "napi_ambient" }],
		[
			"the profile was named explicitly",
			{ NEON_API_KEY: "napi_ambient" },
			"work",
		],
	])("stays quiet when %s", (_name, vars, profile?: string) => {
		const home = makeProfiles(
			{
				"credentials.json": apiKeyFile("napi_default"),
				"credentials.work.json": apiKeyFile("napi_work"),
			},
			{
				DEFAULT: { credentials: "credentials.json" },
				work: { credentials: "credentials.work.json" },
			},
		);
		const warnings: string[] = [];

		resolveApiKey({
			...(profile !== undefined ? { profile } : {}),
			env: { HOME: home, ...vars },
			warn: (message) => warnings.push(message),
		});

		expect(warnings).toEqual([]);
	});
});
