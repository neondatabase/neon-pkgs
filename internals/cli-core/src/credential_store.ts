import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
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
import { profilesFilePath } from "./profiles.js";

export const KEYRING_SERVICE = "com.neon.neon-cli";

/** The addon collapses missing, locked, and denied states, so callers cannot assume absence. */
export type KeyringBackend = {
	get(service: string, account: string): string | null;
	set(service: string, account: string, password: string): void;
	delete(service: string, account: string): boolean;
};

/** Hashing the resolved profiles directory isolates config roots while keeping profile names visible. */
export const keyringAccount = (configDir: string, profile: string): string =>
	`cli:${createHash("sha256")
		.update(dirname(profilesFilePath(configDir)))
		.digest("hex")}:${profile}`;

export class KeyringUnavailableError extends Error {
	constructor(profile?: string, kind: "read" | "write" = "read") {
		const loaded = "This CLI cannot use the OS keyring.";
		super(
			profile === undefined
				? `${loaded} Drop \`--keyring\` to keep the credential in a file.`
				: kind === "write"
					? `${loaded} Remove the profile with \`neon profile remove ${profile} --yes\`.`
					: `${loaded} Use the npm-installed neon, or --api-key or NEON_API_KEY. To reset the profile: \`neon profile remove ${profile} --yes\`.`,
		);
		this.name = "KeyringUnavailableError";
	}
}

export class KeyringUnreadableError extends Error {
	constructor(profile: string) {
		const replace = `\`neon auth --profile ${profile}\``;
		super(
			`Could not read the OS keyring item for profile "${profile}". Unlock the keyring and retry, or run ${replace}. To reset the profile: \`neon profile remove ${profile} --yes\`.`,
		);
		this.name = "KeyringUnreadableError";
	}
}

export class KeyringClearError extends Error {
	constructor(profile: string, kind: "unconfirmed" | "visible" = "visible") {
		const recovery = `\`neon profile remove ${profile} --yes\``;
		super(
			kind === "unconfirmed"
				? `Could not confirm the OS keyring item for profile "${profile}" is gone. The OS store does not distinguish a missing item from denied access. Unlock the OS keyring and retry, or reset the profile with ${recovery} (a leftover may remain; it is unused once the profile is gone).`
				: `Could not clear the OS keyring item for profile "${profile}". Unlock the OS keyring and retry, or reset the profile with ${recovery} (a leftover may remain; it is unused once the profile is gone).`,
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
		options?: { required?: boolean; account?: string },
	): CredentialDeleteResult;
	assertKeyringWritable(profile?: string): void;
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
	let raw: string | null;
	try {
		raw = keyring.get(KEYRING_SERVICE, account);
	} catch {
		return { kind: "absent" };
	}
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

	const assertKeyringWritable = (profile?: string): void => {
		if (keyring === null)
			throw new KeyringUnavailableError(profile, "write");
	};

	const setKeyringOrRollback = (
		profile: string,
		credentials: StoredCredentials,
	): void => {
		assertKeyringWritable(profile);
		const kr = keyring;
		if (kr === null) throw new KeyringUnavailableError(profile, "write");
		const account = accountFor(profile);
		const label = `profile "${profile}"`;
		let previous: string | null = null;
		try {
			previous = kr.get(KEYRING_SERVICE, account);
		} catch {
			previous = null;
		}
		try {
			kr.set(KEYRING_SERVICE, account, JSON.stringify(credentials));
		} catch {
			throw new KeyringUnavailableError();
		}
		try {
			if (kr.get(KEYRING_SERVICE, account) === null) {
				throw new Error(
					`Wrote credentials to the OS keyring for ${label} but could not read them back.`,
				);
			}
		} catch (err) {
			if (previous !== null) {
				try {
					kr.set(KEYRING_SERVICE, account, previous);
				} catch {
					throw new KeyringClearError(profile, "visible");
				}
				let restored: string | null = null;
				try {
					restored = kr.get(KEYRING_SERVICE, account);
				} catch {
					restored = null;
				}
				if (restored === null) {
					throw new KeyringClearError(profile, "visible");
				}
			}
			// A null read may mean the keyring is locked, so deleting could destroy an unreadable secret.
			throw err instanceof Error ? err : new Error(String(err));
		}
	};

	const removeKeyringItem = (
		profile: string,
		required: boolean,
		account = accountFor(profile),
	): "cleared" | "unconfirmed" | "left" => {
		if (keyring === null) {
			if (required) throw new KeyringUnavailableError(profile, "write");
			return "unconfirmed";
		}
		let raw: string | null;
		try {
			raw = keyring.get(KEYRING_SERVICE, account);
		} catch (err) {
			if (!required) return "unconfirmed";
			throw err instanceof Error ? err : new Error(String(err));
		}
		if (raw === null) {
			if (required) throw new KeyringClearError(profile, "unconfirmed");
			return "unconfirmed";
		}
		let deleted: boolean;
		try {
			deleted = keyring.delete(KEYRING_SERVICE, account);
		} catch (err) {
			if (!required) return "unconfirmed";
			throw err instanceof Error ? err : new Error(String(err));
		}
		let still: string | null;
		try {
			still = keyring.get(KEYRING_SERVICE, account);
		} catch (err) {
			if (!required) return "unconfirmed";
			throw err instanceof Error ? err : new Error(String(err));
		}
		if (!deleted || still !== null) {
			if (required) throw new KeyringClearError(profile, "visible");
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
					reason: new KeyringUnavailableError(at.profile).message,
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
				reason: new KeyringUnreadableError(at.profile).message,
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
			if (keyring === null) throw new KeyringUnavailableError(at.profile);
			let raw: string | null;
			try {
				raw = keyring.get(KEYRING_SERVICE, accountFor(at.profile));
			} catch {
				throw new KeyringUnreadableError(at.profile);
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
		deleteOptions?: { required?: boolean; account?: string },
	): CredentialDeleteResult => {
		const required = deleteOptions?.required !== false;
		if (at.storage === CRED_STORAGE_KEYRING) {
			return removeKeyringItem(
				at.profile,
				required,
				deleteOptions?.account,
			);
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
