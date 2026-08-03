import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configDir, legacyConfigDir, resolveConfigFile } from "./paths.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

/** A temp home. `where` seeds `credentials.json` into the named config dirs. */
function makeHome(where: Array<"neon" | "neonctl"> = []): string {
	const root = mkdtempSync(join(tmpdir(), "neon-paths-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	for (const name of where) {
		const dir = resolve(root, ".config", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(resolve(dir, "credentials.json"), `{"from":"${name}"}`);
	}
	return root;
}

const tmpDir = () => {
	const d = mkdtempSync(join(tmpdir(), "neon-paths-explicit-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
};

describe("configDir — precedence", () => {
	test("defaults to <home>/.config/neon", () => {
		const home = makeHome();
		expect(configDir({ env: { HOME: home } })).toBe(
			resolve(home, ".config", "neon"),
		);
	});

	test("honours XDG_CONFIG_HOME over <home>/.config", () => {
		const home = makeHome();
		const xdg = tmpDir();
		expect(configDir({ env: { HOME: home, XDG_CONFIG_HOME: xdg } })).toBe(
			join(xdg, "neon"),
		);
	});

	test("falls back to USERPROFILE on Windows-style env", () => {
		const home = makeHome();
		expect(configDir({ env: { USERPROFILE: home } })).toBe(
			resolve(home, ".config", "neon"),
		);
	});

	test("NEON_CONFIG_DIR wins over the computed default", () => {
		const home = makeHome();
		const custom = tmpDir();
		expect(
			configDir({ env: { HOME: home, NEON_CONFIG_DIR: custom } }),
		).toBe(custom);
	});

	test("NEONCTL_CONFIG_DIR is still honoured, but NEON_CONFIG_DIR wins", () => {
		const legacyVar = tmpDir();
		const currentVar = tmpDir();
		expect(configDir({ env: { NEONCTL_CONFIG_DIR: legacyVar } })).toBe(
			legacyVar,
		);
		expect(
			configDir({
				env: {
					NEONCTL_CONFIG_DIR: legacyVar,
					NEON_CONFIG_DIR: currentVar,
				},
			}),
		).toBe(currentVar);
	});

	test("an explicit dir option beats every environment variable", () => {
		const flag = tmpDir();
		expect(
			configDir({
				dir: flag,
				env: {
					HOME: makeHome(),
					NEON_CONFIG_DIR: tmpDir(),
					NEONCTL_CONFIG_DIR: tmpDir(),
					XDG_CONFIG_HOME: tmpDir(),
				},
			}),
		).toBe(flag);
	});

	test("whitespace-only values are treated as unset", () => {
		const home = makeHome();
		expect(
			configDir({
				dir: "   ",
				env: { HOME: home, NEON_CONFIG_DIR: "  " },
			}),
		).toBe(resolve(home, ".config", "neon"));
	});
});

describe("legacyConfigDir", () => {
	test("is the sibling neonctl directory by default", () => {
		const home = makeHome();
		expect(legacyConfigDir({ env: { HOME: home } })).toBe(
			resolve(home, ".config", "neonctl"),
		);
	});

	// An explicitly chosen directory has no legacy counterpart — `--config-dir /tmp/ci`
	// silently reading ~/.config/neonctl would defeat the point of passing the flag.
	test("is undefined when the directory was chosen explicitly", () => {
		expect(legacyConfigDir({ dir: tmpDir() })).toBeUndefined();
		expect(
			legacyConfigDir({ env: { NEON_CONFIG_DIR: tmpDir() } }),
		).toBeUndefined();
		expect(
			legacyConfigDir({ env: { NEONCTL_CONFIG_DIR: tmpDir() } }),
		).toBeUndefined();
	});
});

describe("resolveConfigFile", () => {
	test("prefers an existing file in neon/", () => {
		const home = makeHome(["neon", "neonctl"]);
		const r = resolveConfigFile("credentials.json", {
			env: { HOME: home },
		});
		expect(r.path).toBe(
			resolve(home, ".config", "neon", "credentials.json"),
		);
		expect(r.isLegacy).toBe(false);
		expect(r.exists).toBe(true);
	});

	// The load-bearing case: an existing install keeps using its file where it already is.
	test("uses an existing legacy file in place", () => {
		const home = makeHome(["neonctl"]);
		const r = resolveConfigFile("credentials.json", {
			env: { HOME: home },
		});
		expect(r.path).toBe(
			resolve(home, ".config", "neonctl", "credentials.json"),
		);
		expect(r.isLegacy).toBe(true);
		expect(r.exists).toBe(true);
	});

	test("points at neon/ when the file exists in neither — new files land there", () => {
		const home = makeHome();
		const r = resolveConfigFile("profiles.json", { env: { HOME: home } });
		expect(r.path).toBe(resolve(home, ".config", "neon", "profiles.json"));
		expect(r.isLegacy).toBe(false);
		expect(r.exists).toBe(false);
	});

	test("never searches the legacy directory when a directory was given explicitly", () => {
		const home = makeHome(["neonctl"]);
		const empty = tmpDir();
		const r = resolveConfigFile("credentials.json", {
			dir: empty,
			env: { HOME: home },
		});
		expect(r.path).toBe(resolve(empty, "credentials.json"));
		expect(r.isLegacy).toBe(false);
		expect(r.exists).toBe(false);
	});

	test("resolves per file, not per directory", () => {
		// credentials.json only in legacy, profiles.json only in current: each resolves
		// independently, so a half-populated new directory cannot strand the old one.
		const home = makeHome(["neonctl"]);
		const currentDir = resolve(home, ".config", "neon");
		mkdirSync(currentDir, { recursive: true });
		writeFileSync(resolve(currentDir, "profiles.json"), "{}");

		const creds = resolveConfigFile("credentials.json", {
			env: { HOME: home },
		});
		const profiles = resolveConfigFile("profiles.json", {
			env: { HOME: home },
		});

		expect(creds.isLegacy).toBe(true);
		expect(profiles.isLegacy).toBe(false);
	});
});
