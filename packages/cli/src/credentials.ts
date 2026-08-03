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
 * // api_key, stored by `neon profile create --api-key`
 * { "type": "api_key", "api_key": "napi_…", "user_id": "…" }
 *
 * // api_key minted by `--mint --org-id`, which records the scope it was issued at
 * { "type": "api_key", "api_key": "napi_…", "key_id": 123, "org_id": "org-…" }
 * ```
 *
 * ## One profile, one kind
 *
 * A credentials file holds an API key or an OAuth session, never both, and `type` states
 * which. An earlier draft let the two coexist — the idea being that a key could keep the
 * session it was minted from and so rotate without a browser. It did not survive review, for
 * two reasons that are worth recording so nobody rebuilds it:
 *
 * 1. **It never worked.** The resolver returned the key without testing it, so a revoked key
 *    failed to mint and never fell back to the session sitting beside it.
 * 2. **It could mix accounts.** Nothing compared the identity of the credential being written
 *    with the one already there, so a profile could hold one account's session and another's
 *    key, told apart only by a single string. Flip or lose `type` and the profile silently
 *    becomes a different person.
 *
 * Recovery from a dead key is therefore one browser login — `neon profile create <name>
 * --mint --force` — which is what the retained session was supposed to save and never did.
 *
 * ## Older releases
 *
 * A CLI predating this reads the pointer, finds no `type` it understands, ignores it, and
 * looks for `access_token`. An `api_key` profile has none, so an older release falls through
 * to its browser login rather than crashing. That it does not crash is why `credentials`
 * stays a required pointer: an entry without one makes 2.41 and 2.42 throw
 * `ERR_INVALID_ARG_TYPE` from `resolveEntryPath`.
 */

import { readFileSync } from "node:fs";
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
	/** Set when the key was minted for an organization rather than the account. */
	org_id?: string;
	/** Set when the key was narrowed to a single project. Implies `org_id`. */
	project_id?: string;
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
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (err) {
		// Absent is "no credentials". Unreadable is not: a permission or I/O error means there
		// may be a perfectly good credential here that we cannot see, and treating it as absent
		// would send the user to a browser login that overwrites it.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
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
/** The scope a minted key was issued at. Absent org means an account key. */
export type KeyScope = {
	orgId?: string;
	projectId?: string;
};

/**
 * Build an `api_key` credentials object. Nothing from a previous credential is carried over.
 *
 * The scope is stored because it is not recoverable from the secret: `rotate-key` has to mint
 * the replacement on the same endpoint, and an org or project key minted as an account key
 * would silently widen what the profile reaches.
 */
export const apiKeyCredentials = ({
	apiKey,
	keyId,
	userId,
	scope,
}: {
	apiKey: string;
	keyId?: number;
	userId?: string;
	scope?: KeyScope;
}): StoredCredentials => ({
	type: API_KEY,
	api_key: apiKey,
	...(keyId !== undefined ? { key_id: keyId } : {}),
	...(userId !== undefined ? { user_id: userId } : {}),
	...(scope?.orgId !== undefined ? { org_id: scope.orgId } : {}),
	...(scope?.projectId !== undefined ? { project_id: scope.projectId } : {}),
});

/** The scope recorded on a stored credential. */
export const scopeOf = (credentials: StoredCredentials): KeyScope => ({
	...(typeof credentials.org_id === "string"
		? { orgId: credentials.org_id }
		: {}),
	...(typeof credentials.project_id === "string"
		? { projectId: credentials.project_id }
		: {}),
});

/** How to describe a scope in output. */
export const describeScope = (scope: KeyScope): string => {
	if (scope.projectId !== undefined) return `project ${scope.projectId}`;
	if (scope.orgId !== undefined) return `org ${scope.orgId}`;
	return "account";
};

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
