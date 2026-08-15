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
} from "@neon-internals/cli-core/cli_config";
import {
	createCredentialStore,
	KEYRING_SERVICE,
	type KeyringBackend,
	KeyringClearError,
	KeyringUnavailableError,
	KeyringUnreadableError,
	keyringAccount,
} from "@neon-internals/cli-core/credential_store";
import type {
	CredentialLocation,
	FileCredentialLocation,
} from "@neon-internals/cli-core/credentials";
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

const fileAt = (
	dir: string,
	file = "credentials.json",
	profile = "DEFAULT",
): FileCredentialLocation => ({
	profile,
	storage: "file",
	path: resolve(dir, file),
});

const keyringAt = (profile = "DEFAULT"): CredentialLocation => ({
	profile,
	storage: "keyring",
});

describe("keyringAccount", () => {
	test("namespaces by resolved config directory and profile", () => {
		expect(keyringAccount("/tmp/a", "DEFAULT")).toBe(
			`cli:${createHash("sha256").update(resolve("/tmp/a")).digest("hex")}:DEFAULT`,
		);
		expect(keyringAccount("/tmp/a", "DEFAULT")).not.toBe(
			keyringAccount("/tmp/b", "DEFAULT"),
		);
		expect(keyringAccount("/tmp/a", "DEFAULT")).not.toBe(
			keyringAccount("/tmp/a", "work"),
		);
		expect(keyringAccount("/tmp/a", "DEFAULT")).toBe(
			keyringAccount("/tmp/a/.", "DEFAULT"),
		);
	});
});

describe("createCredentialStore — file", () => {
	test("reads and writes a file", () => {
		const dir = makeDir();
		const store = createCredentialStore(dir, { keyring: memoryKeyring() });
		const at = fileAt(dir);
		store.write(at, key);
		expect(store.read(at)?.backend).toBe(CRED_STORAGE_FILE);
		expect(store.read(at)?.credentials).toEqual(key);
		expect(JSON.parse(readFileSync(at.path, "utf8"))).toEqual(key);
	});

	test("read of a missing file is null", () => {
		const dir = makeDir();
		const store = createCredentialStore(dir, { keyring: null });
		expect(store.read(fileAt(dir))).toBeNull();
	});

	test("inspect reports ok, missing, and invalid", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify(key),
			"broken.json": "not json",
		});
		const store = createCredentialStore(dir, { keyring: null });
		expect(store.inspect(fileAt(dir))).toMatchObject({
			file: "ok",
			storage: CRED_STORAGE_FILE,
			credentials: key,
		});
		expect(store.inspect(fileAt(dir, "gone.json"))).toMatchObject({
			file: "missing",
			storage: CRED_STORAGE_FILE,
			credentials: null,
		});
		expect(store.inspect(fileAt(dir, "broken.json"))).toMatchObject({
			file: "invalid",
			storage: CRED_STORAGE_FILE,
			credentials: null,
		});
	});

	test("delete removes an owned file and leaves an adopted one", () => {
		const dir = makeDir({ "credentials.json": JSON.stringify(key) });
		const outside = makeDir({ "adopted.json": JSON.stringify(key) });
		const store = createCredentialStore(dir, { keyring: null });
		store.delete(fileAt(dir));
		expect(existsSync(resolve(dir, "credentials.json"))).toBe(false);
		const adopted = fileAt(outside, "adopted.json");
		store.delete(adopted);
		expect(existsSync(adopted.path)).toBe(true);
	});
});

describe("createCredentialStore — keyring", () => {
	test("reads and writes a keyring item", () => {
		const dir = makeDir();
		const keyring = memoryKeyring();
		const store = createCredentialStore(dir, { keyring });
		const at = keyringAt();
		store.write(at, key);
		expect(store.read(at)?.backend).toBe(CRED_STORAGE_KEYRING);
		expect(store.read(at)?.credentials).toEqual(key);
		expect(existsSync(resolve(dir, "credentials.json"))).toBe(false);
		expect(
			keyring.get(KEYRING_SERVICE, keyringAccount(dir, "DEFAULT")),
		).toBe(JSON.stringify(key));
	});

	test("two config directories do not share a DEFAULT slot", () => {
		const a = makeDir();
		const b = makeDir();
		const keyring = memoryKeyring();
		createCredentialStore(a, { keyring }).write(keyringAt(), {
			...key,
			user_id: "a",
		});
		createCredentialStore(b, { keyring }).write(keyringAt(), {
			...key,
			user_id: "b",
		});
		expect(
			createCredentialStore(a, { keyring }).read(keyringAt())?.credentials
				.user_id,
		).toBe("a");
		expect(
			createCredentialStore(b, { keyring }).read(keyringAt())?.credentials
				.user_id,
		).toBe("b");
	});

	test("two profiles in one directory do not share a slot", () => {
		const dir = makeDir();
		const keyring = memoryKeyring();
		const store = createCredentialStore(dir, { keyring });
		store.write(keyringAt("DEFAULT"), { ...key, user_id: "default" });
		store.write(keyringAt("work"), { ...key, user_id: "work" });
		expect(store.read(keyringAt("DEFAULT"))?.credentials.user_id).toBe(
			"default",
		);
		expect(store.read(keyringAt("work"))?.credentials.user_id).toBe("work");
	});

	test("read of get() === null throws KeyringUnreadableError", () => {
		const dir = makeDir();
		const store = createCredentialStore(dir, { keyring: memoryKeyring() });
		expect(() => store.read(keyringAt())).toThrow(KeyringUnreadableError);
		expect(() => store.read(keyringAt())).toThrow(
			/Unlock the keyring and retry/,
		);
		expect(() => store.read(keyringAt())).not.toThrow(/null/);
	});

	test("read without a backend throws KeyringUnavailableError", () => {
		const dir = makeDir();
		const store = createCredentialStore(dir, { keyring: null });
		expect(() => store.read(keyringAt())).toThrow(KeyringUnavailableError);
		expect(() => store.read(keyringAt())).toThrow(
			`\`neon profile mv DEFAULT --file ${resolve(dir, "credentials.json")}\``,
		);
		expect(() => store.assertKeyringWritable()).toThrow(
			KeyringUnavailableError,
		);
		expect(() => store.assertKeyringWritable()).toThrow(
			"pointing at a path in the config directory",
		);
		expect(() => store.assertKeyringWritable()).not.toThrow(/mv DEFAULT/);
	});

	test("inspect uses file=unreadable and does not throw when get() is null", () => {
		const dir = makeDir();
		const store = createCredentialStore(dir, { keyring: memoryKeyring() });
		expect(store.inspect(keyringAt())).toEqual({
			file: "unreadable",
			storage: CRED_STORAGE_KEYRING,
			credentials: null,
			reason: 'Could not read the OS keyring item for profile "DEFAULT".',
		});
	});

	test("inspect names the missing addon without throwing", () => {
		const dir = makeDir();
		const store = createCredentialStore(dir, { keyring: null });
		expect(store.inspect(keyringAt())).toEqual({
			file: "unreadable",
			storage: CRED_STORAGE_KEYRING,
			credentials: null,
			reason: "This CLI cannot use the OS keyring.",
		});
	});

	test("delete required throws when get() is null", () => {
		const dir = makeDir();
		const store = createCredentialStore(dir, { keyring: memoryKeyring() });
		expect(() => store.delete(keyringAt())).toThrow(KeyringClearError);
		expect(() => store.delete(keyringAt())).toThrow(
			/Could not confirm the OS keyring item/,
		);
		expect(() => store.delete(keyringAt())).toThrow(
			`\`neon profile mv DEFAULT --file ${resolve(dir, "credentials.json")} --force\``,
		);
	});

	test("delete required:false does not throw when get() is null", () => {
		const dir = makeDir();
		const store = createCredentialStore(dir, { keyring: memoryKeyring() });
		expect(store.delete(keyringAt(), { required: false })).toBe(
			"unconfirmed",
		);
	});

	test("delete reports left when the OS item is still readable", () => {
		const dir = makeDir();
		const keyring: KeyringBackend = {
			get: () => JSON.stringify(key),
			set: () => undefined,
			delete: () => false,
		};
		const store = createCredentialStore(dir, { keyring });
		expect(store.delete(keyringAt(), { required: false })).toBe("left");
	});

	test("delete of an owned file reports cleared or absent", () => {
		const dir = makeDir({
			"credentials.json": JSON.stringify(key),
		});
		const store = createCredentialStore(dir, { keyring: null });
		expect(store.delete(fileAt(dir))).toBe("cleared");
		expect(store.delete(fileAt(dir), { required: false })).toBe("absent");
	});

	test("write rolls back a new item when it cannot be read back", () => {
		const dir = makeDir();
		let reads = 0;
		const items = new Map<string, string>();
		const id = (service: string, account: string) =>
			`${service}\0${account}`;
		const keyring: KeyringBackend = {
			get: (service, account) => {
				reads += 1;
				if (reads === 2) return null;
				return items.get(id(service, account)) ?? null;
			},
			set: (service, account, password) => {
				items.set(id(service, account), password);
			},
			delete: (service, account) => items.delete(id(service, account)),
		};
		const store = createCredentialStore(dir, { keyring });
		expect(() => store.write(keyringAt(), key)).toThrow(
			/could not read them back/,
		);
		expect(items.size).toBe(0);
	});

	test("an unusable keyring payload does not quote the secret", () => {
		const dir = makeDir();
		const keyring = memoryKeyring();
		keyring.set(
			KEYRING_SERVICE,
			keyringAccount(dir, "DEFAULT"),
			'{"api_key":napi_LEAKED',
		);
		const store = createCredentialStore(dir, { keyring });
		expect(() => store.read(keyringAt())).toThrow(/not valid JSON/);
		try {
			store.read(keyringAt());
		} catch (err) {
			expect(String(err)).not.toContain("napi_LEAKED");
		}
	});
});
