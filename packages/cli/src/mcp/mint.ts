import { isNeonApiError, type NeonApiClient } from "../api.js";
import { orgIdForProject } from "../commands/api_keys.js";
import { log } from "../log.js";
import { mintedKeyName } from "../profile_keys.js";
import { getCliName } from "../utils/cli_name.js";

export type MintedMcpKey = {
	id: number;
	name: string;
	key: string;
	orgId?: string;
	projectId?: string;
};

const cannotMintMessage =
	"This CLI credential cannot mint API keys. Organization and project-scoped keys cannot create other keys. Sign in with `neon auth` or pass a personal API key.";

export function mintedKeyRevokeCommand(
	key: Pick<MintedMcpKey, "id" | "orgId">,
): string {
	return key.orgId
		? `${getCliName()} api-keys revoke ${key.id} --org-id ${key.orgId}`
		: `${getCliName()} api-keys revoke ${key.id}`;
}

const withdraw = async (
	client: NeonApiClient,
	keyId: number | undefined,
	orgId?: string,
): Promise<boolean> => {
	if (!Number.isSafeInteger(keyId) || keyId === undefined || keyId <= 0) {
		return false;
	}
	try {
		const { data } = orgId
			? await client.revokeOrgApiKey(orgId, keyId)
			: await client.revokeApiKey(keyId);
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

const assertUsable = async (
	client: NeonApiClient,
	data: { id?: number; key?: string; name?: string; project_id?: string },
	fallbackName: string,
	scope: { orgId?: string; projectId?: string },
): Promise<MintedMcpKey> => {
	const wanted = scope.projectId;
	const problem =
		typeof data.key !== "string" || data.key.trim() === ""
			? "Neon returned no key."
			: data.project_id !== wanted
				? wanted === undefined
					? `Neon returned a key scoped to ${data.project_id} rather than the whole account.`
					: `Neon returned a key scoped to ${data.project_id ?? "nothing"} rather than ${wanted}.`
				: !Number.isSafeInteger(data.id)
					? "Neon returned no key id."
					: null;
	if (problem) {
		const withdrawn = await withdraw(client, data.id, scope.orgId);
		throw new Error(
			`${problem} ${
				withdrawn
					? "The key has been revoked; nothing was issued."
					: `The key could NOT be revoked and may still be live${
							data.id === undefined
								? ""
								: `. Remove it with \`${mintedKeyRevokeCommand({
										id: data.id,
										orgId: scope.orgId,
									})}\``
						}.`
			}`,
		);
	}

	const id = data.id;
	const key = data.key;
	if (id === undefined || key === undefined) {
		throw new Error("Neon returned no key.");
	}

	return {
		id,
		name: data.name ?? fallbackName,
		key,
		orgId: scope.orgId,
		projectId: scope.projectId,
	};
};

const createAndAssert = async (
	client: NeonApiClient,
	create: () => Promise<{
		data: {
			id?: number;
			key?: string;
			name?: string;
			project_id?: string;
		};
	}>,
	name: string,
	scope: { orgId?: string; projectId?: string },
): Promise<MintedMcpKey> => {
	try {
		const { data } = await create();
		return assertUsable(client, data, name, scope);
	} catch (err) {
		if (isNeonApiError(err) && (err.status === 403 || err.status === 404)) {
			throw new Error(cannotMintMessage);
		}
		throw err;
	}
};

export async function mintMcpApiKey(options: {
	apiClient: NeonApiClient;
	projectId?: string;
}): Promise<MintedMcpKey> {
	const name = mintedKeyName("mcp");
	const projectId = options.projectId;
	if (projectId !== undefined) {
		const orgId = await orgIdForProject(
			options.apiClient,
			projectId,
			"mcp",
		);
		return createAndAssert(
			options.apiClient,
			() =>
				options.apiClient.createOrgApiKey(orgId, {
					key_name: name,
					project_id: projectId,
				}),
			name,
			{ orgId, projectId },
		);
	}
	return createAndAssert(
		options.apiClient,
		() => options.apiClient.createApiKey({ key_name: name }),
		name,
		{},
	);
}

export async function withdrawMintedKey(
	apiClient: NeonApiClient,
	key: MintedMcpKey,
): Promise<boolean> {
	return withdraw(apiClient, key.id, key.orgId);
}
