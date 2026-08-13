import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	CRED_STORAGE_FILE,
	CRED_STORAGE_KEYRING,
	NEON_TOKEN_STORAGE,
	resolveCredStorage,
} from "@neon-internals/cli-core/cli_config";
import {
	createCredentialStore,
	KEYRING_SERVICE,
	type KeyringBackend,
	KeyringUnavailableError,
	keyringAccount,
} from "@neon-internals/cli-core/credential_store";
import { afterEach, describe, expect, test } from "vitest";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function makeDir(files: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "neon-cred-store-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(resolve(root, name), contents, { mode: 0o600 });
	}
	return root;
}

function memoryKeyring(): KeyringBackend & { size(): number } {
	const items = new Map<string, string>();
	const id = (service: string, account: string) => `${service}\0${account}`;
	return {
		get: (service, account) => items.get(id(service, account)) ?? null,
		set: (service, account, password) => {
			items.set(id(service, account), password);
		},
		delete: (service, account) => items.delete(id(service, account)),
		size: () => items.size,
	};
}

const key = { type: "api_key", api_key: "napi_store_test", user_id: "u1" };
const at = (dir: string, file = "credentials.json", profile = "DEFAULT") => ({
	path: resolve(dir, file),
	profile,
});

describe("resolveCredStorage", () => {
	test("defaults to file", () => {
		const dir = makeDir();
		expect(resolveCredStorage(dir, {})).toEqual({
			credStorage: CRED_STORAGE_FILE,
			source: "default",
		});
	});

	test("reads config.json", () => {
		const dir = makeDir({
			"config.json": JSON.stringify({ credStorage: "keyring" }),
		});
		expect(resolveCredStorage(dir, {})).toEqual({
			credStorage: CRED_STORAGE_KEYRING,
			source: "config.json",
		});
	});

	test("NEON_TOKEN_STORAGE overrides config.json", () => {
		const dir = makeDir({
			"config.json": JSON.stringify({ credStorage: "keyring" }),
		});
		expect(
			resolveCredStorage(dir, { [NEON_TOKEN_STORAGE]: "file" }),
		).toEqual({
			credStorage: CRED_STORAGE_FILE,
			source: NEON_TOKEN_STORAGE,
		});
	});

	test("rejects an unknown env value without quoting it", () => {
		const dir = makeDir();
		expect(() =>
			resolveCredStorage(dir, { [NEON_TOKEN_STORAGE]: "auto" }),
		).toThrow(/must be "file" or "keyring"/);
		expect(() =>
			resolveCredStorage(dir, { [NEON_TOKEN_STORAGE]: "auto" }),
		).not.toThrow(/auto/);
	});

	test("rejects invalid JSON in config.json without quoting contents", () => {
		const dir = makeDir({
			"config.json": '{"credStorage":napi_LEAKED',
		});
		expect(() => resolveCredStorage(dir, {})).toThrow(/not valid JSON/);
		try {
			resolveCredStorage(dir, {});
		} catch (err) {
			expect(String(err)).not.toContain("napi_LEAKED");
		}
	});
});

describe("keyringAccount", () => {
	test("is cli: plus the full sha256 of the path", () => {
		const path = "/tmp/neon/credentials.json";
		expect(keyringAccount(path)).toBe(
			`cli:${createHash("sha256").update(path).digest("hex")}`,
		);
	});
});

describe("createCredentialStore", () => {
	test("reads and writes a file when storage is file", () => {
		const dir = makeDir();
		const store = createCredentialStore(dir, {
			env: {},
			keyring: memoryKeyring(),
		});
		const location = at(dir);
		store.write(location, key);
		expect(store.read(location)?.backend).toBe(CRED_STORAGE_FILE);
		expect(store.read(location)?.credentials).toEqual(key);
		expect(JSON.parse(readFileSync(location.path, "utf8"))).toEqual(key);
	});

	test("writes to the keyring and deletes the owned file", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify(key),
		});
		const ring = memoryKeyring();
		const store = createCredentialStore(dir, {
			env: { [NEON_TOKEN_STORAGE]: "keyring" },
			keyring: ring,
		});
		const location = at(dir);
		store.write(location, key);
		expect(existsSync(location.path)).toBe(false);
		expect(store.read(location)?.backend).toBe(CRED_STORAGE_KEYRING);
		expect(store.read(location)?.credentials).toEqual(key);
		expect(ring.size()).toBe(1);
	});

	test("does not migrate on read when both stores are present", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify(key),
		});
		const ring = memoryKeyring();
		ring.set(
			KEYRING_SERVICE,
			keyringAccount(resolve(dir, "credentials.json")),
			JSON.stringify({
				type: "api_key",
				api_key: "napi_from_keyring",
				user_id: "u2",
			}),
		);
		const store = createCredentialStore(dir, {
			env: { [NEON_TOKEN_STORAGE]: "keyring" },
			keyring: ring,
		});
		const location = at(dir);
		expect(store.read(location)?.credentials.api_key).toBe(
			"napi_from_keyring",
		);
		expect(existsSync(location.path)).toBe(true);
		expect(JSON.parse(readFileSync(location.path, "utf8")).api_key).toBe(
			"napi_store_test",
		);
	});

	test("preferred file wins when both stores are present", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify(key),
		});
		const ring = memoryKeyring();
		ring.set(
			KEYRING_SERVICE,
			keyringAccount(resolve(dir, "credentials.json")),
			JSON.stringify({
				type: "api_key",
				api_key: "napi_from_keyring",
			}),
		);
		const store = createCredentialStore(dir, {
			env: {},
			keyring: ring,
		});
		expect(store.read(at(dir))?.credentials.api_key).toBe(
			"napi_store_test",
		);
	});

	test("an adopted path stays on disk and is never deleted", () => {
		const dir = makeDir();
		const outside = makeDir({
			"adopted.json": JSON.stringify(key),
		});
		const adopted = resolve(outside, "adopted.json");
		writeFileSync(
			resolve(dir, "profiles.json"),
			JSON.stringify({
				version: 1,
				profiles: {
					work: { credentials: adopted },
				},
			}),
		);
		const ring = memoryKeyring();
		const store = createCredentialStore(dir, {
			env: { [NEON_TOKEN_STORAGE]: "keyring" },
			keyring: ring,
		});
		const location = { path: adopted, profile: "work" };
		store.write(location, key);
		expect(existsSync(adopted)).toBe(true);
		expect(store.read(location)?.backend).toBe(CRED_STORAGE_FILE);
		store.delete(location);
		expect(existsSync(adopted)).toBe(true);
		expect(ring.size()).toBe(0);
	});

	test("delete removes both owned copies", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify(key),
		});
		const ring = memoryKeyring();
		const store = createCredentialStore(dir, {
			env: { [NEON_TOKEN_STORAGE]: "keyring" },
			keyring: ring,
		});
		const location = at(dir);
		store.write(location, key);
		store.delete(location);
		expect(existsSync(location.path)).toBe(false);
		expect(ring.size()).toBe(0);
		expect(store.read(location)).toBeNull();
	});

	test("migrateTo writes the destination, then config, then deletes the source", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify(key),
		});
		const ring = memoryKeyring();
		const store = createCredentialStore(dir, {
			env: {},
			keyring: ring,
		});
		const location = at(dir);
		const result = store.migrateTo(CRED_STORAGE_KEYRING);
		expect(result.migrated).toEqual([
			{ name: "DEFAULT", path: location.path },
		]);
		expect(existsSync(location.path)).toBe(false);
		expect(
			JSON.parse(readFileSync(resolve(dir, "config.json"), "utf8")),
		).toEqual({
			credStorage: "keyring",
		});
		expect(store.read(location)?.backend).toBe(CRED_STORAGE_KEYRING);
	});

	test("migrateTo leaves the source when the destination cannot be written", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify(key),
		});
		const store = createCredentialStore(dir, {
			env: {},
			keyring: {
				get: () => null,
				set: () => {
					throw new Error("keyring full");
				},
				delete: () => false,
			},
		});
		const location = at(dir);
		expect(() => store.migrateTo(CRED_STORAGE_KEYRING)).toThrow(
			/keyring full/,
		);
		expect(existsSync(location.path)).toBe(true);
		expect(existsSync(resolve(dir, "config.json"))).toBe(false);
	});

	test("migrateTo skips adopted profiles and does not delete them", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify(key),
		});
		const outside = makeDir({
			"adopted.json": JSON.stringify(key),
		});
		const adopted = resolve(outside, "adopted.json");
		writeFileSync(
			resolve(dir, "profiles.json"),
			JSON.stringify({
				version: 1,
				profiles: {
					DEFAULT: { credentials: "credentials.json" },
					work: { credentials: adopted },
				},
			}),
		);
		const store = createCredentialStore(dir, {
			env: {},
			keyring: memoryKeyring(),
		});
		const result = store.migrateTo(CRED_STORAGE_KEYRING);
		expect(result.adopted).toEqual([{ name: "work", path: adopted }]);
		expect(existsSync(adopted)).toBe(true);
		expect(existsSync(resolve(dir, "credentials.json"))).toBe(false);
	});

	test("migrateTo file does not touch the keyring when nothing lived there", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify(key),
		});
		let deletes = 0;
		const ring = memoryKeyring();
		const store = createCredentialStore(dir, {
			env: {},
			keyring: {
				get: ring.get,
				set: ring.set,
				delete: (service, account) => {
					deletes += 1;
					return ring.delete(service, account);
				},
			},
		});
		store.migrateTo(CRED_STORAGE_FILE);
		expect(deletes).toBe(0);
		expect(existsSync(resolve(dir, "credentials.json"))).toBe(true);
	});

	test("inspect reports file status separately from storage", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify(key),
		});
		const ring = memoryKeyring();
		const store = createCredentialStore(dir, {
			env: {},
			keyring: ring,
		});
		store.migrateTo(CRED_STORAGE_KEYRING);
		const listing = store.inspect(at(dir));
		expect(listing.file).toBe("missing");
		expect(listing.storage).toBe(CRED_STORAGE_KEYRING);
		expect(listing.credentials).toEqual(key);
	});

	test("throws when keyring is preferred, unavailable, and no file remains", () => {
		const dir = makeDir({
			"config.json": JSON.stringify({ credStorage: "keyring" }),
		});
		const store = createCredentialStore(dir, {
			env: {},
			keyring: null,
		});
		expect(() => store.read(at(dir))).toThrow(KeyringUnavailableError);
	});

	test("falls back to a leftover file when keyring is preferred but unavailable", () => {
		const dir = makeDir({
			"config.json": JSON.stringify({ credStorage: "keyring" }),
			"credentials.json": JSON.stringify(key),
		});
		const store = createCredentialStore(dir, {
			env: {},
			keyring: null,
		});
		expect(store.read(at(dir))?.backend).toBe(CRED_STORAGE_FILE);
	});

	test("invalid JSON in the keyring is fatal and does not quote the secret", () => {
		const dir = makeDir();
		const ring = memoryKeyring();
		ring.set(
			KEYRING_SERVICE,
			keyringAccount(resolve(dir, "credentials.json")),
			'{"api_key":napi_LEAKED',
		);
		const store = createCredentialStore(dir, {
			env: { [NEON_TOKEN_STORAGE]: "keyring" },
			keyring: ring,
		});
		expect(() => store.read(at(dir))).toThrow(/not valid JSON/);
		try {
			store.read(at(dir));
		} catch (err) {
			expect(String(err)).not.toContain("napi_LEAKED");
		}
	});
});
