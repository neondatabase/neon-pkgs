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
});
