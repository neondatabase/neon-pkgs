/**
 * Where a profile's credential is stored — a file, or the OS keyring.
 *
 * A profile is still a name → path. The path is the identity of the credential
 * even when the secret lives in the keyring: the keyring account is hashed from
 * that path, so two profiles never share a slot, and an adopted path outside
 * the config directory stays file-backed forever.
 *
 * Reads never migrate. Switching storage is `migrateTo`, which writes and
 * verifies the destination, persists `config.json`, then deletes the source.
 */

import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import {
	CRED_STORAGE_FILE,
	CRED_STORAGE_KEYRING,
	type CredStorage,
	readCliConfig,
	resolveCredStorage,
	type StoragePreference,
	writeCliConfig,
} from "./cli_config.js";
import {
	type CredentialLocation,
	type CredentialsRead,
	credentialsRepairHint,
	inspectCredentials,
	parseCredentialsJson,
	readCredentials,
	type StoredCredentials,
	writeCredentials,
} from "./credentials.js";
import { isOwnedCredentialPath } from "./paths.js";
import { listProfiles } from "./profiles.js";

export const KEYRING_SERVICE = "com.neon.neon-cli";

export type KeyringBackend = {
	get(service: string, account: string): string | null;
	set(service: string, account: string, password: string): void;
	delete(service: string, account: string): boolean;
};

export const keyringAccount = (path: string): string =>
	`cli:${createHash("sha256").update(path).digest("hex")}`;

export class KeyringUnavailableError extends Error {
	constructor(
		message = 'Credential storage is set to "keyring", but this CLI cannot use the OS keyring. Use the npm-installed neon CLI, or set storage to file with `neon profile storage file`.',
	) {
		super(message);
		this.name = "KeyringUnavailableError";
	}
}

export type LoadedCredential = {
	credentials: StoredCredentials;
	backend: CredStorage;
	path: string;
	profile: string;
};

export type CredentialListing = {
	file: "ok" | "missing" | "invalid";
	storage: CredStorage | "-";
	credentials: StoredCredentials | null;
	reason?: string;
};

export type MigratedProfile = {
	name: string;
	path: string;
};

export type SkippedProfile = {
	name: string;
	path: string;
	reason: string;
};

export type MigrateResult = {
	credStorage: CredStorage;
	migrated: MigratedProfile[];
	adopted: MigratedProfile[];
	skipped: SkippedProfile[];
};

export type CreateCredentialStoreOptions = {
	env?: NodeJS.ProcessEnv;
	keyring?: KeyringBackend | null;
};

export type CredentialStore = {
	preference(): StoragePreference;
	inspect(at: CredentialLocation): CredentialListing;
	read(at: CredentialLocation): LoadedCredential | null;
	write(
		at: CredentialLocation,
		credentials: StoredCredentials,
		options?: { backend?: CredStorage },
	): LoadedCredential;
	delete(at: CredentialLocation): void;
	migrateTo(mode: CredStorage): MigrateResult;
};

const deleteFileIfPresent = (path: string): boolean => {
	if (!existsSync(path)) return false;
	rmSync(path);
	return true;
};

const inspectKeyringItem = (
	keyring: KeyringBackend | null,
	path: string,
): CredentialsRead => {
	if (keyring === null) return { kind: "absent" };
	const raw = keyring.get(KEYRING_SERVICE, keyringAccount(path));
	if (raw === null) return { kind: "absent" };
	return parseCredentialsJson(raw, `the OS keyring item for ${path}`);
};

export const createCredentialStore = (
	dir: string,
	options: CreateCredentialStoreOptions = {},
): CredentialStore => {
	const env = options.env ?? process.env;
	const keyring = options.keyring ?? null;

	const preference = (): StoragePreference => resolveCredStorage(dir, env);

	const requireKeyring = (): KeyringBackend => {
		if (keyring === null) throw new KeyringUnavailableError();
		return keyring;
	};

	const inspect = (at: CredentialLocation): CredentialListing => {
		const fileRead = inspectCredentials(at.path);
		const file =
			fileRead.kind === "ok"
				? "ok"
				: fileRead.kind === "absent"
					? "missing"
					: "invalid";
		const fileReason =
			fileRead.kind === "unusable" ? fileRead.reason : undefined;

		const owned = isOwnedCredentialPath(dir, at.path);
		const keyringRead = owned
			? inspectKeyringItem(keyring, at.path)
			: { kind: "absent" as const };
		const keyringReason =
			keyringRead.kind === "unusable" ? keyringRead.reason : undefined;

		const preferred = preference().credStorage;
		const fileCreds = fileRead.kind === "ok" ? fileRead.credentials : null;
		const keyringCreds =
			keyringRead.kind === "ok" ? keyringRead.credentials : null;

		let storage: CredStorage | "-" = "-";
		let credentials: StoredCredentials | null = null;
		if (preferred === CRED_STORAGE_KEYRING && keyringCreds !== null) {
			storage = CRED_STORAGE_KEYRING;
			credentials = keyringCreds;
		} else if (preferred === CRED_STORAGE_FILE && fileCreds !== null) {
			storage = CRED_STORAGE_FILE;
			credentials = fileCreds;
		} else if (keyringCreds !== null) {
			storage = CRED_STORAGE_KEYRING;
			credentials = keyringCreds;
		} else if (fileCreds !== null) {
			storage = CRED_STORAGE_FILE;
			credentials = fileCreds;
		}

		const reason = fileReason ?? keyringReason;
		return {
			file,
			storage,
			credentials,
			...(reason !== undefined ? { reason } : {}),
		};
	};

	const readFile = (at: CredentialLocation): LoadedCredential | null => {
		const credentials = readCredentials(at);
		if (credentials === null) return null;
		return {
			credentials,
			backend: CRED_STORAGE_FILE,
			path: at.path,
			profile: at.profile,
		};
	};

	const readKeyring = (at: CredentialLocation): LoadedCredential | null => {
		if (keyring === null) {
			if (preference().credStorage === CRED_STORAGE_KEYRING) {
				const fileCopy = readFile(at);
				if (fileCopy !== null) return fileCopy;
				throw new KeyringUnavailableError();
			}
			return null;
		}
		const raw = keyring.get(KEYRING_SERVICE, keyringAccount(at.path));
		if (raw === null) return null;
		const parsed = parseCredentialsJson(
			raw,
			`the OS keyring item for ${at.path}`,
		);
		if (parsed.kind !== "ok") {
			if (parsed.kind === "unusable") {
				throw new Error(
					`${parsed.reason}. ${credentialsRepairHint(at)}`,
				);
			}
			return null;
		}
		return {
			credentials: parsed.credentials,
			backend: CRED_STORAGE_KEYRING,
			path: at.path,
			profile: at.profile,
		};
	};

	const read = (at: CredentialLocation): LoadedCredential | null => {
		if (!isOwnedCredentialPath(dir, at.path)) return readFile(at);

		const preferred = preference().credStorage;
		if (preferred === CRED_STORAGE_KEYRING) {
			const fromKeyring = readKeyring(at);
			if (fromKeyring !== null) return fromKeyring;
			return readFile(at);
		}
		const fromFile = readFile(at);
		if (fromFile !== null) return fromFile;
		return readKeyring(at);
	};

	const write = (
		at: CredentialLocation,
		credentials: StoredCredentials,
		writeOptions?: { backend?: CredStorage },
	): LoadedCredential => {
		const owned = isOwnedCredentialPath(dir, at.path);
		const target = owned
			? (writeOptions?.backend ?? preference().credStorage)
			: CRED_STORAGE_FILE;

		if (target === CRED_STORAGE_KEYRING) {
			const kr = requireKeyring();
			const account = keyringAccount(at.path);
			kr.set(KEYRING_SERVICE, account, JSON.stringify(credentials));
			if (kr.get(KEYRING_SERVICE, account) === null) {
				throw new Error(
					`Wrote credentials to the OS keyring for ${at.path} but could not read them back.`,
				);
			}
			if (owned) deleteFileIfPresent(at.path);
			return {
				credentials,
				backend: CRED_STORAGE_KEYRING,
				path: at.path,
				profile: at.profile,
			};
		}

		writeCredentials(at.path, credentials);
		if (owned && keyring !== null) {
			keyring.delete(KEYRING_SERVICE, keyringAccount(at.path));
		}
		return {
			credentials,
			backend: CRED_STORAGE_FILE,
			path: at.path,
			profile: at.profile,
		};
	};

	const del = (at: CredentialLocation): void => {
		if (!isOwnedCredentialPath(dir, at.path)) return;
		deleteFileIfPresent(at.path);
		if (keyring !== null) {
			keyring.delete(KEYRING_SERVICE, keyringAccount(at.path));
		}
	};

	const migrateTo = (mode: CredStorage): MigrateResult => {
		if (mode === CRED_STORAGE_KEYRING) requireKeyring();

		const migrated: MigratedProfile[] = [];
		const adopted: MigratedProfile[] = [];
		const skipped: SkippedProfile[] = [];
		let sawKeyring = false;

		for (const profile of listProfiles(dir)) {
			const at = {
				path: profile.credentialsPath,
				profile: profile.name,
			};
			if (!isOwnedCredentialPath(dir, at.path)) {
				adopted.push({ name: profile.name, path: at.path });
				continue;
			}

			const loaded = read(at);
			if (loaded === null) {
				skipped.push({
					name: profile.name,
					path: at.path,
					reason: "no stored credential",
				});
				continue;
			}

			if (loaded.backend === CRED_STORAGE_KEYRING) sawKeyring = true;
			if (loaded.backend !== mode) {
				if (mode === CRED_STORAGE_KEYRING) {
					const kr = requireKeyring();
					const account = keyringAccount(at.path);
					kr.set(
						KEYRING_SERVICE,
						account,
						JSON.stringify(loaded.credentials),
					);
					if (kr.get(KEYRING_SERVICE, account) === null) {
						throw new Error(
							`Could not verify the keyring write for profile "${profile.name}". Left the credentials file in place.`,
						);
					}
				} else {
					writeCredentials(at.path, loaded.credentials);
					const verify = inspectCredentials(at.path);
					if (verify.kind !== "ok") {
						throw new Error(
							`Could not verify the credentials file write for profile "${profile.name}". Left the keyring item in place.`,
						);
					}
				}
			}
			migrated.push({ name: profile.name, path: at.path });
		}

		const config = readCliConfig(dir);
		writeCliConfig(dir, { ...config, credStorage: mode });

		for (const item of migrated) {
			if (mode === CRED_STORAGE_KEYRING) {
				deleteFileIfPresent(item.path);
			} else if (keyring !== null && sawKeyring) {
				keyring.delete(KEYRING_SERVICE, keyringAccount(item.path));
			}
		}

		return { credStorage: mode, migrated, adopted, skipped };
	};

	return {
		preference,
		inspect,
		read,
		write,
		delete: del,
		migrateTo,
	};
};
