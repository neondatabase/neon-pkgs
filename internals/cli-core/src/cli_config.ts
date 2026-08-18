export const CRED_STORAGE_FILE = "file";
export const CRED_STORAGE_KEYRING = "keyring";

export type CredStorage =
	| typeof CRED_STORAGE_FILE
	| typeof CRED_STORAGE_KEYRING;
