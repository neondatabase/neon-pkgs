/**
 * CLI configuration that is not a secret — today, where credentials are stored.
 *
 * Lives in `config.json` next to `credentials.json`. It never holds a token or an
 * API key. `profiles.json` stays a name → path map; this file is the one place a
 * storage preference is recorded.
 */

import { readFileSync } from "node:fs";
import { resolveConfigFile } from "./paths.js";
import { writeSecretFile } from "./secure_file.js";

export const CONFIG_FILE = "config.json";
export const NEON_CRED_STORAGE = "NEON_CRED_STORAGE";

export const CRED_STORAGE_FILE = "file";
export const CRED_STORAGE_KEYRING = "keyring";

export type CredStorage =
	| typeof CRED_STORAGE_FILE
	| typeof CRED_STORAGE_KEYRING;

export const isCredStorage = (value: unknown): value is CredStorage =>
	value === CRED_STORAGE_FILE || value === CRED_STORAGE_KEYRING;

export type CliConfig = {
	credStorage?: CredStorage;
	[key: string]: unknown;
};

export type StoragePreferenceSource =
	| "config.json"
	| typeof NEON_CRED_STORAGE
	| "default";

export type StoragePreference = {
	credStorage: CredStorage;
	source: StoragePreferenceSource;
};

const invalidStorageMessage = (where: string): string =>
	`${where} must be "${CRED_STORAGE_FILE}" or "${CRED_STORAGE_KEYRING}".`;

/**
 * Read `config.json`, or `{}` when it is absent.
 *
 * Invalid JSON is fatal and the parser's message is discarded — the file sits
 * next to secrets, and V8 quotes a window of the input around a syntax error.
 */
export const readCliConfig = (dir: string): CliConfig => {
	const resolved = resolveConfigFile(CONFIG_FILE, { dir });
	let contents: string;
	try {
		contents = readFileSync(resolved.path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		throw new Error(
			`${resolved.path} is not valid JSON, so CLI configuration cannot be read`,
		);
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed)
	) {
		throw new Error(
			`${resolved.path} does not contain a configuration object`,
		);
	}
	return parsed as CliConfig;
};

export const writeCliConfig = (dir: string, config: CliConfig): void => {
	const { path } = resolveConfigFile(CONFIG_FILE, { dir });
	writeSecretFile(path, `${JSON.stringify(config, null, 2)}\n`);
};

export const resolveCredStorage = (
	dir: string,
	env: NodeJS.ProcessEnv = process.env,
): StoragePreference => {
	const raw = env[NEON_CRED_STORAGE];
	if (typeof raw === "string" && raw.trim() !== "") {
		const value = raw.trim();
		if (!isCredStorage(value)) {
			throw new Error(invalidStorageMessage(NEON_CRED_STORAGE));
		}
		return { credStorage: value, source: NEON_CRED_STORAGE };
	}

	const config = readCliConfig(dir);
	if (!("credStorage" in config) || config.credStorage === undefined) {
		return { credStorage: CRED_STORAGE_FILE, source: "default" };
	}
	if (!isCredStorage(config.credStorage)) {
		const { path } = resolveConfigFile(CONFIG_FILE, { dir });
		throw new Error(
			`${path} has a "credStorage" this version does not understand. ${invalidStorageMessage('"credStorage"')}`,
		);
	}
	return { credStorage: config.credStorage, source: "config.json" };
};
