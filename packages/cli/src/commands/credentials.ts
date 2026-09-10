import type {
	CreateCredentialResponse,
	CredentialMeta,
	CredentialScope,
	CredentialSecret,
	RotateCredentialResponse,
} from "@neon/sdk";
import type yargs from "yargs";
import { isNeonApiError, messageFromBody, retryOnLock } from "../api.js";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import { branchIdFromProps, fillSingleProject } from "../utils/enrichers.js";
import { writer } from "../writer.js";

const CREDENTIAL_SCOPES = [
	"storage:read",
	"storage:write",
	"ai_gateway:invoke",
	"functions:invoke",
] as const satisfies readonly CredentialScope[];

const LIST_FIELDS = [
	"token_id",
	"name",
	"principal_type",
	"scopes",
	"created_at",
] as const;

const SECRET_META_FIELDS = ["token_id", "name", "scopes"] as const;

const renderColumns = {
	scopes: (c: CredentialMeta) => (c.scopes ?? []).join(", "),
} as const;

type CreateProps = BranchScopeProps & {
	name?: string;
	scope: CredentialScope[];
};

type TokenProps = BranchScopeProps & { tokenId: string };

/** Translate a token-id 404 into a resource-specific message; re-throw everything else. */
async function withCredentialNotFound<T>(
	tokenId: string,
	branchId: string,
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run();
	} catch (err) {
		if (isNeonApiError(err) && err.status === 404) {
			const message = messageFromBody(err.data) ?? "";
			if (message.includes("platform credentials not available")) {
				throw err;
			}
			throw new Error(
				`Credential ${tokenId} not found on branch ${branchId}.`,
			);
		}
		throw err;
	}
}

/**
 * Secrets are shown only once (create/rotate) or on demand (reveal). Table
 * output keeps them off the grid so they stay one selectable line; json/yaml
 * keep them on the object for scripts.
 */
const reportSecrets = (
	props: BranchScopeProps,
	data:
		| CreateCredentialResponse
		| RotateCredentialResponse
		| CredentialSecret,
	warning: string,
) => {
	const out = writer(props);
	if (props.output === "table") {
		out.write(data as never, {
			fields: SECRET_META_FIELDS as never,
		});
		out.end();
		const apiToken =
			"api_token" in data && typeof data.api_token === "string"
				? data.api_token
				: "";
		const secretKey =
			"s3_secret_access_key" in data &&
			typeof data.s3_secret_access_key === "string"
				? data.s3_secret_access_key
				: "";
		out.text(`api_token: ${apiToken}\n`);
		out.text(`s3_secret_access_key: ${secretKey}\n`);
	} else {
		out.end(data as never, {
			fields: [
				"token_id",
				"name",
				"scopes",
				"api_token",
				"s3_secret_access_key",
			] as never,
		});
	}
	log.warning(warning);
};

export const command = "credentials";
export const describe = "Manage branch credentials";
export const aliases = ["credential"];
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 credentials <sub-command> [options]")
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
			branch: {
				describe: "Branch ID or name",
				type: "string",
			},
		})
		.middleware(fillSingleProject as any)
		.command(
			"list",
			"List credentials on the branch",
			(yargs) => yargs,
			(args) => list(args as any),
		)
		.command(
			"create",
			"Issue a scoped credential on the branch",
			(yargs) =>
				yargs.options({
					name: {
						describe: "Label for the credential",
						type: "string",
					},
					scope: {
						describe:
							"Capability to grant. Repeatable. Values: storage:read, storage:write, ai_gateway:invoke, functions:invoke",
						type: "string",
						array: true,
						choices: CREDENTIAL_SCOPES,
						demandOption: true,
					},
				}),
			(args) => create(args as any),
		)
		.command(
			"reveal <tokenId>",
			"Show a credential's api_token and s3_secret_access_key",
			(yargs) =>
				yargs.positional("tokenId", {
					describe: "Credential token id (nak_live_<32hex>)",
					type: "string",
				}),
			(args) => reveal(args as any),
		)
		.command(
			"rotate <tokenId>",
			"Replace a credential's secrets in place. The token id is unchanged.",
			(yargs) =>
				yargs.positional("tokenId", {
					describe: "Credential token id (nak_live_<32hex>)",
					type: "string",
				}),
			(args) => rotate(args as any),
		)
		.command(
			"revoke <tokenId>",
			"Revoke a credential",
			(yargs) =>
				yargs.positional("tokenId", {
					describe: "Credential token id (nak_live_<32hex>)",
					type: "string",
				}),
			(args) => revoke(args as any),
		);

export const handler = (args: yargs.Argv) => {
	return args;
};

export const list = async (props: BranchScopeProps) => {
	const branchId = await branchIdFromProps(props);
	const { data } = await props.apiClient.listCredentials(
		props.projectId,
		branchId,
	);
	writer(props).end(data.credentials, {
		fields: LIST_FIELDS,
		renderColumns,
		emptyMessage: "No credentials found on this branch.",
	});
};

export const create = async (props: CreateProps) => {
	const branchId = await branchIdFromProps(props);
	const scopes = (
		Array.isArray(props.scope) ? props.scope : [props.scope]
	).filter((scope): scope is CredentialScope =>
		CREDENTIAL_SCOPES.some((allowed) => allowed === scope),
	);
	if (scopes.length === 0) {
		throw new Error(
			"Pass at least one --scope. Values: storage:read, storage:write, ai_gateway:invoke, functions:invoke",
		);
	}
	const { data } = await retryOnLock(() =>
		props.apiClient.createCredential(props.projectId, branchId, {
			scopes,
			principal_type: "user",
			...(props.name !== undefined ? { name: props.name } : {}),
		}),
	);
	reportSecrets(
		props,
		data,
		"Store these secrets now: they are not shown again unless you run neon credentials reveal.",
	);
};

export const reveal = async (props: TokenProps) => {
	const branchId = await branchIdFromProps(props);
	const { data } = await withCredentialNotFound(props.tokenId, branchId, () =>
		props.apiClient.revealCredential(
			props.projectId,
			branchId,
			props.tokenId,
		),
	);
	reportSecrets(
		props,
		data,
		"These are live secrets. Treat them like a password.",
	);
};

export const rotate = async (props: TokenProps) => {
	const branchId = await branchIdFromProps(props);
	const { data } = await withCredentialNotFound(props.tokenId, branchId, () =>
		retryOnLock(() =>
			props.apiClient.rotateCredential(
				props.projectId,
				branchId,
				props.tokenId,
			),
		),
	);
	reportSecrets(
		props,
		data,
		"Store the new secrets now: a retry mints another pair and does not recover a lost response. A replica may briefly accept the previous secret.",
	);
};

export const revoke = async (props: TokenProps) => {
	const branchId = await branchIdFromProps(props);
	await withCredentialNotFound(props.tokenId, branchId, () =>
		retryOnLock(() =>
			props.apiClient.revokeCredential(
				props.projectId,
				branchId,
				props.tokenId,
			),
		),
	);
	log.info(`Credential ${props.tokenId} revoked`);
};
