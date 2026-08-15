/**
 * Where a profile's credential is stored — a file, or the OS keyring.
 *
 * The profile pointer in `profiles.json` is the only answer. `credentials` is a
 * file path, or the sentinel `"keyring"`. Reads never migrate. Moving storage
 * is `neon profile mv`.
 */

import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
	CRED_STORAGE_FILE,
	CRED_STORAGE_KEYRING,
	type CredStorage,
} from "./cli_config.js";
import {
	type CredentialLocation,
	type CredentialsRead,
	credentialLabel,
	inspectCredentials,
	parseCredentialsJson,
	readCredentials,
	type StoredCredentials,
	writeCredentials,
} from "./credentials.js";
import { isOwnedCredentialPath } from "./paths.js";
import { defaultCredentialsFileName } from "./profiles.js";

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

/**
 * OS account for one profile in one config directory.
 *
 * Namespaced by the resolved config directory so two `--config-dir` roots
 * cannot share a `DEFAULT` slot. The profile name is not hashed so a Keychain
 * listing still names the profile.
 */
export const keyringAccount = (configDir: string, profile: string): string =>
	`cli:${createHash("sha256").update(resolve(configDir)).digest("hex")}:${profile}`;

const keyringFileRecovery = (configDir: string, profile: string): string =>
	`neon profile mv ${profile} --file ${resolve(configDir, defaultCredentialsFileName(profile))}`;

export class KeyringUnavailableError extends Error {
	constructor(profile?: string, configDir?: string) {
		const recovery =
			profile !== undefined && configDir !== undefined
				? `or move the profile to a file with \`${keyringFileRecovery(configDir, profile)}\``
				: "or move the profile to a file with `neon profile mv` and `--file` pointing at a path in the config directory";
		super(
			`This CLI cannot use the OS keyring. Use a neon CLI build that includes the keyring addon, ${recovery}.`,
		);
		this.name = "KeyringUnavailableError";
	}
}

/**
 * The profile pointer says keyring, and `get` returned null. The addon maps
 * locked, denied, and missing to the same null, so this is not "never signed in".
 */
export class KeyringUnreadableError extends Error {
	constructor(profile: string) {
		const replace =
			profile === "DEFAULT"
				? "`neon auth`"
				: `\`neon auth --profile ${profile}\``;
		super(
			`Could not read the OS keyring item for profile "${profile}". Unlock the keyring and retry, or run ${replace}.`,
		);
		this.name = "KeyringUnreadableError";
	}
}

export class KeyringClearError extends Error {
	constructor(
		profile: string,
		configDir: string,
		kind: "unconfirmed" | "visible" = "visible",
	) {
		const recovery = `\`${keyringFileRecovery(configDir, profile)} --force\``;
		super(
			kind === "unconfirmed"
				? `Could not confirm the OS keyring item for profile "${profile}" is gone. The OS store does not distinguish a missing item from denied access. Unlock the OS keyring and retry, or run ${recovery} to stop using the keyring.`
				: `Could not clear the OS keyring item for profile "${profile}". Unlock the OS keyring and retry, or run ${recovery} (may leave a leftover; it is not used once the pointer is a file).`,
		);
		this.name = "KeyringClearError";
	}
}

export type LoadedCredential = {
	credentials: StoredCredentials;
	backend: CredStorage;
	profile: string;
	path?: string;
};

export type CredentialListing = {
	file: "ok" | "missing" | "invalid" | "unreadable";
	storage: CredStorage;
	credentials: StoredCredentials | null;
	reason?: string;
};

export type CreateCredentialStoreOptions = {
	keyring?: KeyringBackend | null;
};

export type CredentialDeleteResult =
	| "cleared"
	| "unconfirmed"
	| "left"
	| "skipped"
	| "absent";

export type CredentialStore = {
	inspect(at: CredentialLocation): CredentialListing;
	read(at: CredentialLocation): LoadedCredential | null;
	write(
		at: CredentialLocation,
		credentials: StoredCredentials,
	): LoadedCredential;
	delete(
		at: CredentialLocation,
		options?: { required?: boolean },
	): CredentialDeleteResult;
	assertKeyringWritable(): void;
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
	return parseCredentialsJson(raw, label);
};

export const createCredentialStore = (
	dir: string,
	options: CreateCredentialStoreOptions = {},
): CredentialStore => {
	const keyring = options.keyring ?? null;

	const accountFor = (profile: string): string =>
		keyringAccount(dir, profile);

	const assertKeyringWritable = (): void => {
		if (keyring === null) throw new KeyringUnavailableError();
	};

	const setKeyringOrRollback = (
		profile: string,
		credentials: StoredCredentials,
	): void => {
		assertKeyringWritable();
		const kr = keyring;
		if (kr === null) throw new KeyringUnavailableError(profile, dir);
		const account = accountFor(profile);
		const label = `profile "${profile}"`;
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
					throw new KeyringClearError(profile, dir, "visible");
				}
			} else {
				const deleted = kr.delete(KEYRING_SERVICE, account);
				let still: string | null = null;
				try {
					still = kr.get(KEYRING_SERVICE, account);
				} catch {
					still = null;
				}
				if (!deleted || still !== null) {
					throw new KeyringClearError(profile, dir, "visible");
				}
			}
			throw err instanceof Error ? err : new Error(String(err));
		}
	};

	const removeKeyringItem = (
		profile: string,
		required: boolean,
	): "cleared" | "unconfirmed" | "left" => {
		if (keyring === null) {
			if (required) throw new KeyringUnavailableError(profile, dir);
			return "unconfirmed";
		}
		let raw: string | null;
		try {
			raw = keyring.get(KEYRING_SERVICE, accountFor(profile));
		} catch (err) {
			throw err instanceof Error ? err : new Error(String(err));
		}
		if (raw === null) {
			if (required)
				throw new KeyringClearError(profile, dir, "unconfirmed");
			return "unconfirmed";
		}
		const deleted = keyring.delete(KEYRING_SERVICE, accountFor(profile));
		let still: string | null;
		try {
			still = keyring.get(KEYRING_SERVICE, accountFor(profile));
		} catch (err) {
			throw err instanceof Error ? err : new Error(String(err));
		}
		if (!deleted || still !== null) {
			if (required) throw new KeyringClearError(profile, dir, "visible");
			return "left";
		}
		return "cleared";
	};

	const inspect = (at: CredentialLocation): CredentialListing => {
		if (at.storage === CRED_STORAGE_KEYRING) {
			if (keyring === null) {
				return {
					file: "unreadable",
					storage: CRED_STORAGE_KEYRING,
					credentials: null,
					reason: "This CLI cannot use the OS keyring.",
				};
			}
			const keyringRead = inspectKeyringItem(
				keyring,
				accountFor(at.profile),
				credentialLabel(at),
			);
			if (keyringRead.kind === "ok") {
				return {
					file: "ok",
					storage: CRED_STORAGE_KEYRING,
					credentials: keyringRead.credentials,
				};
			}
			if (keyringRead.kind === "unusable") {
				return {
					file: "unreadable",
					storage: CRED_STORAGE_KEYRING,
					credentials: null,
					reason: keyringRead.reason,
				};
			}
			return {
				file: "unreadable",
				storage: CRED_STORAGE_KEYRING,
				credentials: null,
				reason: `Could not read the OS keyring item for profile "${at.profile}".`,
			};
		}

		const fileRead = inspectCredentials(at.path);
		const file =
			fileRead.kind === "ok"
				? "ok"
				: fileRead.kind === "absent"
					? "missing"
					: "invalid";
		return {
			file,
			storage: CRED_STORAGE_FILE,
			credentials: fileRead.kind === "ok" ? fileRead.credentials : null,
			...(fileRead.kind === "unusable"
				? { reason: fileRead.reason }
				: {}),
		};
	};

	const read = (at: CredentialLocation): LoadedCredential | null => {
		if (at.storage === CRED_STORAGE_KEYRING) {
			if (keyring === null)
				throw new KeyringUnavailableError(at.profile, dir);
			let raw: string | null;
			try {
				raw = keyring.get(KEYRING_SERVICE, accountFor(at.profile));
			} catch (err) {
				throw err instanceof Error ? err : new Error(String(err));
			}
			if (raw === null) throw new KeyringUnreadableError(at.profile);
			const parsed = parseCredentialsJson(raw, credentialLabel(at));
			if (parsed.kind === "unusable") {
				throw new Error(parsed.reason);
			}
			if (parsed.kind !== "ok") {
				throw new KeyringUnreadableError(at.profile);
			}
			return {
				credentials: parsed.credentials,
				backend: CRED_STORAGE_KEYRING,
				profile: at.profile,
			};
		}

		const credentials = readCredentials(at);
		if (credentials === null) return null;
		return {
			credentials,
			backend: CRED_STORAGE_FILE,
			path: at.path,
			profile: at.profile,
		};
	};

	const write = (
		at: CredentialLocation,
		credentials: StoredCredentials,
	): LoadedCredential => {
		if (at.storage === CRED_STORAGE_KEYRING) {
			setKeyringOrRollback(at.profile, credentials);
			return {
				credentials,
				backend: CRED_STORAGE_KEYRING,
				profile: at.profile,
			};
		}
		writeCredentials(at.path, credentials);
		return {
			credentials,
			backend: CRED_STORAGE_FILE,
			path: at.path,
			profile: at.profile,
		};
	};

	const del = (
		at: CredentialLocation,
		deleteOptions?: { required?: boolean },
	): CredentialDeleteResult => {
		const required = deleteOptions?.required !== false;
		if (at.storage === CRED_STORAGE_KEYRING) {
			return removeKeyringItem(at.profile, required);
		}
		if (!isOwnedCredentialPath(dir, at.path)) return "skipped";
		return deleteFileIfPresent(at.path) ? "cleared" : "absent";
	};

	return {
		inspect,
		read,
		write,
		delete: del,
		assertKeyringWritable,
	};
};
