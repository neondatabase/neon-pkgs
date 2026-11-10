import type { CredentialLocation } from "@neon-internals/cli-core/credentials";
import { getApiClient, type NeonApiClient } from "../api.js";
import {
	authFailureMessage,
	getAuthContext,
	locationFromContext,
} from "../auth_context.js";
import {
	type CredentialProps,
	refreshLockPath,
	usableCredential,
} from "../commands/auth.js";
import { storeFor } from "../credential_io.js";
import { log } from "../log.js";
import { withExclusiveLock } from "../refresh_lock.js";
import { getCliName } from "../utils/cli_name.js";
import type { McpBearer } from "./bridge.js";
import {
	type MintedMcpKey,
	mintedKeyRevokeCommand,
	mintMcpApiKey,
	withdrawMintedKey,
} from "./mint.js";

export type McpServeAuthProps = CredentialProps & {
	apiKey: string;
	apiClient?: NeonApiClient;
	configDir: string;
};

/**
 * The bearer `neon mcp serve` sends. An API key (`--api-key`, `NEON_API_KEY`, or an API-key
 * profile) goes through as is. An OAuth profile goes through the API key stored in its session
 * record, minted on first use: the Neon MCP server rejects OAuth access tokens it did not issue.
 */
export const mcpServeBearer = async (
	props: McpServeAuthProps,
): Promise<McpBearer> => {
	const context = getAuthContext();
	if (!props.apiKey || !props.apiClient || context === null) {
		throw new Error(
			`Not signed in. Run \`${getCliName()} login\`, pass --api-key, or set NEON_API_KEY.`,
		);
	}
	if (context.source === "claimable") {
		throw new Error(
			`The Neon MCP server needs a Neon account credential, and this directory is linked to an unclaimed Claimable Neon project. Pass --profile or --api-key, or claim the project with \`${getCliName()} claim\`.`,
		);
	}
	if (context.source !== "stored-credentials") {
		const token = props.apiKey;
		return {
			token: async () => token,
			replace: async () => {
				throw new Error(authFailureMessage(context));
			},
		};
	}

	const at = locationFromContext(context);
	if (at === null) {
		throw new Error(authFailureMessage(context));
	}
	let current = await sessionMcpKey(props, at, props.apiClient);
	let replaced: { from: string; to: Promise<string> } | undefined;
	return {
		token: async () => current,
		replace: (rejected) => {
			// One replacement per process: a server that rejects a key minted seconds ago would
			// otherwise get a new key minted for every request.
			if (replaced) {
				return rejected === replaced.from
					? replaced.to
					: Promise.reject(
							new Error(
								`The Neon MCP server rejected the API key minted for profile "${at.profile}".`,
							),
						);
			}
			const to = (async () => {
				const session = await usableCredential(props, at);
				if (session === null) {
					throw new Error(authFailureMessage(context));
				}
				current = await sessionMcpKey(
					props,
					at,
					getApiClient({
						apiKey: session.apiKey,
						apiHost: props.apiHost,
					}),
					rejected,
				);
				return current;
			})();
			replaced = { from: rejected, to };
			return to;
		},
	};
};

/**
 * Holds the refresh lock because the session record is rewritten: a concurrent refresh would
 * otherwise have its rotated refresh token overwritten with the spent one.
 */
const sessionMcpKey = (
	props: McpServeAuthProps,
	at: CredentialLocation,
	client: NeonApiClient,
	rejected?: string,
): Promise<string> =>
	withExclusiveLock(refreshLockPath(props.configDir, at), async () => {
		const store = storeFor(props.configDir);
		const loaded = store.read(at);
		if (loaded === null) {
			throw new Error(
				`Profile "${at.profile}" has no stored session. Run \`${getCliName()} login --profile ${at.profile}\`.`,
			);
		}
		const stored = loaded.credentials.mcp_api_key;
		if (
			typeof stored === "string" &&
			stored !== "" &&
			stored !== rejected
		) {
			return stored;
		}

		const minted = await mintMcpApiKey({ apiClient: client });
		try {
			store.write(at, {
				...loaded.credentials,
				mcp_api_key: minted.key,
				mcp_key_id: minted.id,
			});
		} catch (err) {
			throw new Error(await unstoredKeyMessage(client, minted, at, err));
		}
		log.info(
			'Minted API key %s (id %d) for the Neon MCP server and stored it with profile "%s". It is revoked when that session is replaced or the profile is removed.',
			minted.name,
			minted.id,
			at.profile,
		);
		return minted.key;
	});

const unstoredKeyMessage = async (
	client: NeonApiClient,
	minted: MintedMcpKey,
	at: CredentialLocation,
	err: unknown,
): Promise<string> => {
	const reason = err instanceof Error ? err.message : String(err);
	const withdrawn = await withdrawMintedKey(client, minted);
	return `Could not store the Neon MCP server's API key with profile "${at.profile}": ${reason} ${
		withdrawn
			? "The key has been revoked."
			: `The key could NOT be revoked. Remove it with \`${mintedKeyRevokeCommand(minted)}\`.`
	}`;
};
