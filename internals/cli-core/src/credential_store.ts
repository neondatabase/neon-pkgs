/**
 * Where a profile's credential is stored — a file, or the OS keyring.
 *
 * A profile is still a name → path. The path is the identity of the credential
 * even when the secret lives in the keyring: the keyring account is hashed from
 * that path, so two profiles never share a slot, and an adopted path outside
 * the config directory stays file-backed forever.
 *
 * Reads never migrate. Switching storage is `migrateTo`. Destination is
 * written first. Then: keyring→file clears the keyring before persisting
 * file mode; file→keyring persists keyring mode before deleting the file.
 */

import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
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
import { isInsideConfigDir, isOwnedCredentialPath } from "./paths.js";
import { listProfiles } from "./profiles.js";

export const KEYRING_SERVICE = "com.neon.neon-cli";

/**
 * `@napi-rs/keyring@1.3.0` maps every OS error to `null` (get) or `false`
 * (delete), including locked or denied access. Do not treat those as absence
 * or success when a keyring copy may exist.
 */
export type KeyringBackend = {
	get(service: string, account: string): string | null;
	set(service: string, account: string, password: string): void;
	delete(service: string, account: string): boolean;
};

export const keyringAccount = (path: string): string =>
	`cli:${createHash("sha256").update(path).digest("hex")}`;

/**
 * The path whose hash is the keyring account.
 *
 * A legacy `neonctl/credentials.json` is owned, but deleting it makes the next
 * resolve land on `neon/credentials.json`. Hashing the current-dir basename
 * keeps the item findable after that delete. Adopted paths are not remapped.
 */
export const keyringIdentityPath = (
	configDirectory: string,
	path: string,
): string => {
	const resolved = resolve(path);
	if (isInsideConfigDir(configDirectory, resolved)) return resolved;
	if (isOwnedCredentialPath(configDirectory, resolved)) {
		return resolve(configDirectory, basename(resolved));
	}
	return resolved;
};

export class KeyringUnavailableError extends Error {
	constructor(
		message = "This CLI cannot use the OS keyring. Use the npm-installed neon CLI, or run `NEON_CRED_STORAGE=file neon profile storage file --force` to persist file mode.",
	) {
		super(message);
		this.name = "KeyringUnavailableError";
	}
}

/**
 * Preferred storage is the keyring, the credentials file is gone, and `get`
 * returned null. The addon maps locked, denied, and missing to the same
 * null, so this is not "never signed in".
 */
export class KeyringUnreadableError extends Error {
	constructor(profile: string, path: string) {
		const replace =
			profile === "DEFAULT"
				? "`neon auth`"
				: `\`neon auth --profile ${profile}\``;
		super(
			`Profile "${profile}" uses the OS keyring item for ${path}, and the keyring did not return it. Access may have been denied, the keyring may be locked, or the item may have been removed. This CLI will not start a browser sign-in in that situation. Unlock the keyring and retry, or pass --api-key / NEON_API_KEY. To replace the credential, run ${replace}. To stop using the keyring, run \`neon profile storage file\`.`,
		);
		this.name = "KeyringUnreadableError";
	}
}

export class KeyringClearError extends Error {
	constructor(path: string, kind: "unconfirmed" | "visible" = "visible") {
		super(
			kind === "unconfirmed"
				? `Could not confirm the OS keyring item for ${path} is gone. The OS store does not distinguish a missing item from denied access. Unlock the OS keyring and retry, or run \`neon profile storage file\` to persist file mode (a leftover would not be used).`
				: `Could not clear the OS keyring item for ${path}. Unlock the OS keyring and retry, or run \`neon profile storage file --force\` (may leave a leftover; it is not used while storage is file).`,
		);
		this.name = "KeyringClearError";
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
	uncleared: MigratedProfile[];
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
	migrateTo(mode: CredStorage, options?: { force?: boolean }): MigrateResult;
	assertPreferredWritable(): void;
};

const deleteFileIfPresent = (path: string): boolean => {
	if (!existsSync(path)) return false;
	rmSync(path);
	return true;
};

const inspectKeyringItem = (
	keyring: KeyringBackend | null,
	account: string,
	label: string,
): CredentialsRead => {
	if (keyring === null) return { kind: "absent" };
	const raw = keyring.get(KEYRING_SERVICE, account);
	if (raw === null) return { kind: "absent" };
	return parseCredentialsJson(raw, `the OS keyring item for ${label}`);
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

	const setKeyringOrRollback = (
		account: string,
		credentials: StoredCredentials,
		label: string,
	): void => {
		const kr = requireKeyring();
		let previous: string | null = null;
		try {
			previous = kr.get(KEYRING_SERVICE, account);
		} catch {
			previous = null;
		}
		kr.set(KEYRING_SERVICE, account, JSON.stringify(credentials));
		try {
			if (kr.get(KEYRING_SERVICE, account) === null) {
				throw new Error(
					`Wrote credentials to the OS keyring for ${label} but could not read them back.`,
				);
			}
		} catch (err) {
			if (previous !== null) {
				kr.set(KEYRING_SERVICE, account, previous);
				let restored: string | null = null;
				try {
					restored = kr.get(KEYRING_SERVICE, account);
				} catch {
					restored = null;
				}
				if (restored === null) {
					throw new KeyringClearError(label);
				}
				throw err instanceof Error ? err : new Error(String(err));
			}
			const deleted = kr.delete(KEYRING_SERVICE, account);
			let still: string | null = null;
			try {
				still = kr.get(KEYRING_SERVICE, account);
			} catch {
				still = null;
			}
			if (!deleted || still !== null) {
				throw new KeyringClearError(label);
			}
			throw err instanceof Error ? err : new Error(String(err));
		}
	};

	const accountFor = (path: string): string =>
		keyringAccount(keyringIdentityPath(dir, path));

	const assertPreferredWritable = (): void => {
		if (
			preference().credStorage === CRED_STORAGE_KEYRING &&
			keyring === null
		) {
			throw new KeyringUnavailableError();
		}
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
		const preferred = preference().credStorage;
		const shouldProbeKeyring =
			owned && keyring !== null && preferred === CRED_STORAGE_KEYRING;
		let keyringRead: CredentialsRead = { kind: "absent" };
		if (shouldProbeKeyring) {
			try {
				keyringRead = inspectKeyringItem(
					keyring,
					accountFor(at.path),
					at.path,
				);
			} catch (err) {
				if (file === "missing") {
					throw err instanceof Error ? err : new Error(String(err));
				}
			}
		}
		const keyringReason =
			keyringRead.kind === "unusable" ? keyringRead.reason : undefined;

		const fileCreds = fileRead.kind === "ok" ? fileRead.credentials : null;
		const keyringCreds =
			keyringRead.kind === "ok" ? keyringRead.credentials : null;

		let storage: CredStorage | "-" = "-";
		let credentials: StoredCredentials | null = null;
		if (preferred === CRED_STORAGE_KEYRING && keyringCreds !== null) {
			storage = CRED_STORAGE_KEYRING;
			credentials = keyringCreds;
		} else if (
			preferred === CRED_STORAGE_KEYRING &&
			keyringRead.kind === "unusable"
		) {
			storage = CRED_STORAGE_KEYRING;
		} else if (fileCreds !== null) {
			storage = CRED_STORAGE_FILE;
			credentials = fileCreds;
		} else if (owned && preferred === CRED_STORAGE_KEYRING) {
			storage = CRED_STORAGE_KEYRING;
		}

		const unreadReason =
			owned && preferred === CRED_STORAGE_KEYRING && credentials === null
				? keyring === null
					? "This CLI cannot use the OS keyring."
					: `Could not read the OS keyring item for ${at.path}. Access may have been denied, the keyring may be locked, or the item may be gone.`
				: undefined;
		const reason = fileReason ?? keyringReason ?? unreadReason;
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
		let raw: string | null;
		try {
			raw = keyring.get(KEYRING_SERVICE, accountFor(at.path));
		} catch (err) {
			if (preference().credStorage !== CRED_STORAGE_KEYRING) return null;
			throw err instanceof Error ? err : new Error(String(err));
		}
		if (raw === null) return null;
		const parsed = parseCredentialsJson(
			raw,
			`the OS keyring item for ${at.path}`,
		);
		if (parsed.kind !== "ok") {
			if (parsed.kind === "unusable") {
				throw new Error(
					`${parsed.reason}. ${credentialsRepairHint(at, "keyring")}`,
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
			const fromFile = readFile(at);
			if (fromFile !== null) return fromFile;
			throw new KeyringUnreadableError(at.profile, at.path);
		}
		return readFile(at);
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
			const account = accountFor(at.path);
			setKeyringOrRollback(account, credentials, at.path);
			if (owned) deleteFileIfPresent(at.path);
			return {
				credentials,
				backend: CRED_STORAGE_KEYRING,
				path: at.path,
				profile: at.profile,
			};
		}

		if (owned && keyringMayHoldCopy() && keyring === null) {
			throw new KeyringUnavailableError();
		}
		writeCredentials(at.path, credentials);
		if (owned && keyring !== null && keyringMayHoldCopy()) {
			removeKeyringItem(accountFor(at.path), at.path, true);
		}
		return {
			credentials,
			backend: CRED_STORAGE_FILE,
			path: at.path,
			profile: at.profile,
		};
	};

	const keyringMayHoldCopy = (): boolean =>
		preference().credStorage === CRED_STORAGE_KEYRING ||
		readCliConfig(dir).credStorage === CRED_STORAGE_KEYRING;

	const removeKeyringItem = (
		account: string,
		path: string,
		required: boolean,
	): "cleared" | "unconfirmed" | "left" => {
		if (keyring === null) {
			if (required) throw new KeyringUnavailableError();
			return "unconfirmed";
		}
		let raw: string | null;
		try {
			raw = keyring.get(KEYRING_SERVICE, account);
		} catch (err) {
			throw err instanceof Error ? err : new Error(String(err));
		}
		if (raw === null) {
			if (required) throw new KeyringClearError(path, "unconfirmed");
			return "unconfirmed";
		}
		const deleted = keyring.delete(KEYRING_SERVICE, account);
		let still: string | null;
		try {
			still = keyring.get(KEYRING_SERVICE, account);
		} catch (err) {
			throw err instanceof Error ? err : new Error(String(err));
		}
		if (!deleted || still !== null) {
			if (required) throw new KeyringClearError(path, "visible");
			return "left";
		}
		return "cleared";
	};

	const del = (at: CredentialLocation): void => {
		if (!isOwnedCredentialPath(dir, at.path)) return;
		const required = keyringMayHoldCopy();
		if (required && keyring === null) {
			throw new KeyringUnavailableError();
		}
		if (keyring !== null && (required || !existsSync(at.path))) {
			removeKeyringItem(accountFor(at.path), at.path, required);
		}
		deleteFileIfPresent(at.path);
	};

	const migrateTo = (
		mode: CredStorage,
		migrateOptions?: { force?: boolean },
	): MigrateResult => {
		if (mode === CRED_STORAGE_KEYRING) {
			if (keyring === null) {
				throw new KeyringUnavailableError(
					"This CLI cannot use the OS keyring. Use the npm-installed neon CLI.",
				);
			}
		}
		const force = migrateOptions?.force === true;
		const mayHold = keyringMayHoldCopy();

		const migrated: MigratedProfile[] = [];
		const adopted: MigratedProfile[] = [];
		const skipped: SkippedProfile[] = [];
		const uncleared: MigratedProfile[] = [];
		const keyringPaths = new Set<string>();
		const keyringWrites: string[] = [];

		const rollbackKeyringWrites = (): void => {
			if (keyring === null) return;
			for (const path of keyringWrites) {
				keyring.delete(KEYRING_SERVICE, accountFor(path));
			}
		};

		try {
			for (const profile of listProfiles(dir)) {
				const at = {
					path: profile.credentialsPath,
					profile: profile.name,
				};
				if (!isOwnedCredentialPath(dir, at.path)) {
					adopted.push({ name: profile.name, path: at.path });
					continue;
				}

				let loaded: LoadedCredential | null;
				try {
					loaded = read(at);
				} catch (err) {
					const skipUnreadable =
						mode === CRED_STORAGE_FILE &&
						(err instanceof KeyringUnreadableError ||
							(force && err instanceof KeyringUnavailableError));
					if (skipUnreadable) {
						loaded = null;
					} else {
						throw err instanceof Error
							? err
							: new Error(String(err));
					}
				}
				if (loaded === null) {
					skipped.push({
						name: profile.name,
						path: at.path,
						reason: "no stored credential",
					});
					continue;
				}

				if (loaded.backend === CRED_STORAGE_KEYRING) {
					keyringPaths.add(at.path);
				}
				if (loaded.backend !== mode) {
					if (mode === CRED_STORAGE_KEYRING) {
						setKeyringOrRollback(
							accountFor(at.path),
							loaded.credentials,
							`profile "${profile.name}"`,
						);
						keyringWrites.push(at.path);
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

			if (mode === CRED_STORAGE_FILE) {
				for (const item of migrated) {
					const sawKeyring = keyringPaths.has(item.path);
					if (!mayHold && !sawKeyring) continue;
					const status = removeKeyringItem(
						accountFor(item.path),
						item.path,
						sawKeyring && !force,
					);
					if (status !== "cleared") uncleared.push(item);
				}
			}

			const config = readCliConfig(dir);
			writeCliConfig(dir, { ...config, credStorage: mode });
		} catch (err) {
			rollbackKeyringWrites();
			throw err instanceof Error ? err : new Error(String(err));
		}

		if (mode === CRED_STORAGE_KEYRING) {
			for (const item of migrated) {
				deleteFileIfPresent(item.path);
			}
		}

		return { credStorage: mode, migrated, adopted, skipped, uncleared };
	};

	return {
		preference,
		inspect,
		read,
		write,
		delete: del,
		migrateTo,
		assertPreferredWritable,
	};
};
