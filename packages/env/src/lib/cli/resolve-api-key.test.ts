import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveApiKey } from "./resolve-api-key.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

/** A temp home containing `.config/neonctl/credentials.json` with the given contents. */
function makeHome(credentials: string | null): string {
	const root = mkdtempSync(join(tmpdir(), "neon-env-apikey-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const dir = resolve(root, ".config", "neonctl");
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
