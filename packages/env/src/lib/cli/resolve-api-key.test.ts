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
