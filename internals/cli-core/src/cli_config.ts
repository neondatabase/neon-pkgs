/**
 * Storage backends a profile pointer can name.
 *
 * The pointer itself lives on the profile (`profiles.json` `credentials` field),
 * not in this module. These strings are the two values that field and
 * `CredentialLocation.storage` share.
 */

export const CRED_STORAGE_FILE = "file";
export const CRED_STORAGE_KEYRING = "keyring";

export type CredStorage =
	| typeof CRED_STORAGE_FILE
	| typeof CRED_STORAGE_KEYRING;

export const isCredStorage = (value: unknown): value is CredStorage =>
	value === CRED_STORAGE_FILE || value === CRED_STORAGE_KEYRING;
