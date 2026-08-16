import {
	API_KEY,
	type CredentialLocation,
	interpretCredentials,
	isSameCredential,
	type KeyScope,
	OAUTH,
	type StoredCredentials,
	scopeOf,
} from "@neon-internals/cli-core/credentials";
import { getApiClient, type NeonApiClient } from "./api.js";
import { revokeToken } from "./auth.js";
import { storeFor } from "./credential_io.js";
import { log } from "./log.js";
import type { ExtendedTokenSet } from "./types.js";

/** Kept free of command types so auth and profile can share it. */
export type RetireProps = {
	apiHost: string;
	oauthHost: string;
	clientId: string;
	allowUnsafeTls?: boolean;
};

/**
 * Keeps credential-specific revoke inputs together so callers do not read unchecked fields
 * from stored credentials.
 */
export type OutgoingCredential =
	| { kind: typeof API_KEY; apiKey: string; keyId?: number; scope: KeyScope }
	| { kind: typeof OAUTH; tokens: StoredCredentials };

/**
 * Malformed credentials cannot be revoked, but they must remain replaceable and removable.
 */
export const readOutgoingCredential = (
	configDir: string,
	at: CredentialLocation,
): OutgoingCredential | null => {
	const listing = storeFor(configDir).inspect(at);
	const store = listing.storage === "keyring" ? "keyring" : "file";
	const unusable = (reason: string): null => {
		// Avoid a doubled period when the source reason already ends with one.
		log.warning(
			"%s. Nothing in it could be revoked.",
			reason.replace(/\.$/, ""),
		);
		return null;
	};

	if (listing.reason !== undefined && listing.credentials === null) {
		if (at.storage === "keyring") {
			log.warning(
				'Could not read the OS keyring item for profile "%s"; nothing in it could be revoked.',
				at.profile,
			);
			return null;
		}
		return unusable(listing.reason);
	}
	if (listing.credentials === null) return null;

	// Classification accepts declarations missing their secret; interpretation prevents an
	// unauthenticated revoke request while keeping the malformed credential removable.
	try {
		const credential = interpretCredentials(listing.credentials, at, store);
		if (credential.kind === OAUTH) {
			return { kind: OAUTH, tokens: listing.credentials };
		}
		return {
			kind: API_KEY,
			apiKey: credential.apiKey,
			...(typeof listing.credentials.key_id === "number"
				? { keyId: listing.credentials.key_id }
				: {}),
			scope: scopeOf(listing.credentials),
		};
	} catch (err) {
		return unusable(err instanceof Error ? err.message : String(err));
	}
};

/**
 * Read the outgoing credential before overwrite, but retire it only after the replacement is
 * durable: overwrite destroys revocation metadata, while early retirement can strand the
 * profile without a working credential.
 */
export const retirePreviousCredential = async (
	props: RetireProps,
	name: string,
	existing: OutgoingCredential | null,
	/** Prevents re-storing the same key from revoking the credential just committed. */
	replacementKey?: string,
): Promise<void> => {
	if (existing === null) return;

	if (existing.kind === API_KEY) {
		if (isSameCredential(existing.apiKey, replacementKey)) {
			log.debug(
				"The replacement is the credential already stored; nothing to retire.",
			);
			return;
		}
		if (existing.keyId === undefined) {
			log.warning(
				'Profile "%s" held an API key that was supplied rather than minted here, so it stays live on the account — find it with `neon api-keys list`.',
				name,
			);
			return;
		}
		const client = getApiClient({
			apiKey: existing.apiKey,
			apiHost: props.apiHost,
		});
		log.info(
			(await withdrawKey(client, existing.scope, existing.keyId))
				? `Revoked the key it replaces (id ${existing.keyId})`
				: `Could not revoke the key it replaces (id ${existing.keyId}); it may still be live. Remove it with: neon api-keys revoke ${existing.keyId}`,
		);
		return;
	}

	const revoked = await revokeTokenSet(existing.tokens, props);
	log.info(
		revoked
			? "Signed out the session it replaced"
			: "Could not sign out the session it replaced; it will expire on its own",
	);
};

/** A failed revoke must not strand the caller. */
export const withdrawKey = async (
	client: NeonApiClient,
	scope: KeyScope,
	keyId: number | undefined,
): Promise<boolean> => {
	if (!Number.isSafeInteger(keyId) || (keyId as number) <= 0) return false;
	try {
		const { data } = scope.orgId
			? await client.revokeOrgApiKey(scope.orgId, keyId as number)
			: await client.revokeApiKey(keyId as number);
		// A true response for another id does not prove this key was revoked.
		return data.revoked === true && data.id === keyId;
	} catch (err) {
		log.error(
			"Failed to revoke API key %d: %s",
			keyId,
			err instanceof Error ? err.message : String(err),
		);
		return false;
	}
};

export const revokeTokenSet = async (
	credentials: StoredCredentials,
	props: RetireProps,
): Promise<boolean> => {
	const tokenSet = credentials as unknown as ExtendedTokenSet;
	return await revokeToken(
		{
			oauthHost: props.oauthHost,
			clientId: props.clientId,
			...(props.allowUnsafeTls
				? { allowUnsafeTls: props.allowUnsafeTls }
				: {}),
		},
		tokenSet,
	);
};
