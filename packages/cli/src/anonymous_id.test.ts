import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANONYMOUS_ID_FILE, getOrCreateAnonymousId } from "./anonymous_id.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("getOrCreateAnonymousId", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "neon-anon-id-"));
		vi.stubEnv("CI", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates a UUID on first use and stores it owner-only", () => {
		const id = getOrCreateAnonymousId(dir);
		expect(id).toMatch(UUID);
		const path = join(dir, ANONYMOUS_ID_FILE);
		expect(readFileSync(path, "utf8").trim()).toBe(id);
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	});

	it("returns the same id on every later run", () => {
		expect(getOrCreateAnonymousId(dir)).toBe(getOrCreateAnonymousId(dir));
	});

	it("creates the config directory when it does not exist yet", () => {
		const nested = join(dir, "not", "yet");
		expect(getOrCreateAnonymousId(nested)).toMatch(UUID);
		expect(existsSync(join(nested, ANONYMOUS_ID_FILE))).toBe(true);
	});

	it("replaces a file that does not hold a UUID", () => {
		writeFileSync(join(dir, ANONYMOUS_ID_FILE), "not-a-uuid");
		const id = getOrCreateAnonymousId(dir);
		expect(id).toMatch(UUID);
		expect(readFileSync(join(dir, ANONYMOUS_ID_FILE), "utf8").trim()).toBe(
			id,
		);
	});

	it("neither reads nor writes in CI", () => {
		vi.stubEnv("CI", "true");
		expect(getOrCreateAnonymousId(dir)).toBeUndefined();
		expect(existsSync(join(dir, ANONYMOUS_ID_FILE))).toBe(false);
	});

	it("returns nothing, rather than throwing, when the id cannot be stored", () => {
		// A file where the directory should be makes both the read and the mkdir fail.
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "");
		expect(getOrCreateAnonymousId(join(blocker, "sub"))).toBeUndefined();
	});

	it("gives parallel first runs one id", async () => {
		const tsx = fileURLToPath(
			new URL("../node_modules/.bin/tsx", import.meta.url),
		);
		const module = fileURLToPath(
			new URL("./anonymous_id.ts", import.meta.url),
		);
		const go = join(dir, "go");
		// Kept outside the config dir so the children's only shared state is the id file.
		const scripts = mkdtempSync(join(tmpdir(), "neon-anon-id-script-"));
		const script = join(scripts, "child.mts");
		writeFileSync(
			script,
			`import { existsSync } from "node:fs";
const [module, dir, go] = process.argv.slice(2);
const { getOrCreateAnonymousId } = await import(module);
// Hold every child here until all are loaded, so their first reads overlap.
while (!existsSync(go)) {}
console.log(getOrCreateAnonymousId(dir));
`,
		);
		const configDir = join(dir, "config");
		const run = () =>
			new Promise<string>((resolve, reject) => {
				const child = spawn(
					tsx,
					[script, pathToFileURL(module).href, configDir, go],
					{ env: { ...process.env, CI: "" } },
				);
				let out = "";
				let err = "";
				child.stdout.on("data", (chunk) => {
					out += chunk;
				});
				child.stderr.on("data", (chunk) => {
					err += chunk;
				});
				child.on("error", reject);
				child.on("close", (code) =>
					code === 0 ? resolve(out.trim()) : reject(new Error(err)),
				);
			});
		try {
			const children = Array.from({ length: 12 }, run);
			await new Promise((resolve) => setTimeout(resolve, 3000));
			writeFileSync(go, "");
			const ids = await Promise.all(children);
			expect(new Set(ids).size).toBe(1);
			expect(ids[0]).toMatch(UUID);
			expect(
				readFileSync(join(configDir, ANONYMOUS_ID_FILE), "utf8").trim(),
			).toBe(ids[0]);
		} finally {
			rmSync(scripts, { recursive: true, force: true });
		}
	}, 60_000);
});
