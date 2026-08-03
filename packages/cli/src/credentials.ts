/**
 * # Stored credentials — one file per account, two kinds
 *
 * A profile points at exactly one credentials file (see `./profiles.ts`), and that file says
 * what kind of credential it holds. Adding API-key support this way rather than adding a
 * second pointer to `profiles.json` keeps a profile what it already was — one name, one path
 * — and means `profiles.json` needs no schema change at all.
 *
 * ```json
 * // oauth: every file written before this existed. An absent `type` means this.
 * { "access_token": "…", "refresh_token": "…", "expires_at": 1786…, "user_id": "…" }
 *
 * // api_key: imported with `neon profile set-key`
 * { "type": "api_key", "api_key": "napi_…", "user_id": "…" }
 *
 * // api_key minted from an OAuth session, which it keeps so rotation needs no browser
 * { "type": "api_key", "api_key": "napi_…", "key_id": 123, "user_id": "…",
 *   "access_token": "…", "refresh_token": "…", "expires_at": 1786… }
 * ```
 *
 * ## `type` is the whole contract
 *
 * The two shapes are supersets of each other rather than alternatives, and `type` — not
 * "which fields happen to be present" — decides which credential authenticates. That is the
 * point: an API-key file may retain the OAuth token set it was minted from, so
 * `neon profile rotate-key` can replace a revoked key without a browser, and an OAuth file
 * may retain `key_id` so a later rotation can still revoke the key it superseded.
 *
 * Inferring the kind from the fields instead would make both of those impossible, and would
 * silently mis-read a half-written file as the other kind.
 *
 * ## Older releases
 *
 * A CLI predating this reads the pointer, finds no `type` it understands, ignores it, and
 * looks for `access_token`. A minted profile therefore keeps working on an old release; an
 * imported-key profile has no `access_token`, so the old release falls through to its browser
 * login. Neither crashes, which is why `credentials` stays a required pointer.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeSecretFile } from "./utils/secure_file.js";

export const OAUTH = "oauth";
export const API_KEY = "api_key";

export type CredentialKind = typeof OAUTH | typeof API_KEY;

/**
 * The on-disk shape. Every field is optional because the two kinds overlap and because an
 * OAuth token endpoint response carries more than we name here — the index signature keeps
 * those extra fields on a round-trip rather than dropping them.
 */
export type StoredCredentials = {
	type?: string;
	api_key?: string;
	key_id?: number;
	user_id?: string;
	access_token?: string;
	refresh_token?: string;
	expires_at?: number;
	[key: string]: unknown;
};

/**
 * Which credential in this file authenticates, by declaration alone.
 *
 * An unrecognised `type` throws rather than falling back to `oauth`. A file we cannot
 * interpret is a misconfiguration the user has to see: treating it as OAuth would send them
 * to a browser login that silently replaces a credential they meant to keep, and treating it
 * as an API key would authenticate with whatever `api_key` happened to be there.
 *
 * This deliberately does not check that an `api_key` file has a key — `neon profile list`
 * needs the kind of a file it is not about to authenticate with, and must be able to report a
 * broken one rather than throwing halfway through a table.
 */
export const credentialKind = (
	credentials: StoredCredentials,
	path: string,
): CredentialKind => {
	const declared = credentials.type;
	if (declared === undefined || declared === OAUTH) return OAUTH;
	if (declared === API_KEY) return API_KEY;
	throw new Error(
		`${path} has an unrecognised "type": ${JSON.stringify(declared)}. Expected "${OAUTH}" or "${API_KEY}".`,
	);
};

/** A credentials file resolved far enough to authenticate with. */
export type InterpretedCredentials =
	| { kind: typeof API_KEY; apiKey: string }
	| { kind: typeof OAUTH };

/**
 * Resolve what to authenticate with, validating that the declared kind is actually usable.
 *
 * An `api_key` file with no key is a hard error rather than a fall-through to OAuth: the user
 * asked for a key, and quietly opening a browser instead would replace the credential they
 * were trying to fix.
 */
export const interpretCredentials = (
	credentials: StoredCredentials,
	path: string,
): InterpretedCredentials => {
	if (credentialKind(credentials, path) === OAUTH) return { kind: OAUTH };
	const apiKey = nonEmpty(credentials.api_key);
	if (apiKey === undefined) {
		throw new Error(
			`${path} declares "type": "${API_KEY}" but has no "api_key" value. Store one with \`neon profile set-key\`.`,
		);
	}
	return { kind: API_KEY, apiKey };
};

/**
 * Read a credentials file, or `null` when there is nothing usable there.
 *
 * Missing and unparseable both return `null`, because both are recoverable by authenticating
 * again and the callers already treat "no credentials" as "log in". A file that parses but
 * contradicts itself is different — {@link credentialKind} throws for that, since re-running
 * `auth` would paper over a mistake rather than fix it.
 */
export const readCredentials = (path: string): StoredCredentials | null => {
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return null;
	return parsed as StoredCredentials;
};

export const writeCredentials = (
	path: string,
	credentials: StoredCredentials,
): void => {
	writeSecretFile(path, JSON.stringify(credentials));
};

/**
 * Merge new credential material into whatever is already stored, so writing one kind never
 * discards the other. Undefined values in `update` leave the existing field alone; that is
 * how `auth` keeps a `key_id` it did not mint and `set-key` keeps a recovery token set.
 */
export const mergeCredentials = (
	existing: StoredCredentials | null,
	update: StoredCredentials,
	drop: readonly string[] = [],
): StoredCredentials => {
	const merged: StoredCredentials = { ...(existing ?? {}) };
	for (const [key, value] of Object.entries(update)) {
		if (value !== undefined) merged[key] = value;
	}
	for (const key of drop) {
		if (key in merged) merged[key] = undefined;
	}
	// `JSON.stringify` omits undefined values, so dropped fields leave no trace on disk.
	return JSON.parse(JSON.stringify(merged)) as StoredCredentials;
};

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
