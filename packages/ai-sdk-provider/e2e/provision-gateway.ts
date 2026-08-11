import { apiRequest, describeError, statusOf } from "@neon/e2e-harness/api";
import { requireApiKey } from "@neon/e2e-harness/env";
import {
	createProject,
	deleteProject,
	sweepOrphans,
	uniqueProjectName,
} from "@neon/e2e-harness/projects";
// The harness is imported by subpath, never through its barrel: the barrel re-exports the
// `e2eTest` fixture, which imports `vitest`, and `globalSetup` reaches this module from
// outside a worker, where importing `vitest` throws.
import { gatewayBaseUrl } from "./gateway-url.js";

/** A gateway the suite provisioned for itself, and everything needed to tear it down. */
export interface ProvisionedGateway {
	baseUrl: string;
	token: string;
	projectId: string;
	branchId: string;
	tokenId: string;
}

interface Branch {
	id: string;
	default?: boolean;
}

interface Endpoint {
	branch_id: string;
	type: string;
	host: string;
}

interface Credential {
	token_id: string;
	api_token: string;
}

/**
 * Mint the branch credential the gateway accepts. `ai_gateway:invoke` is the only scope the
 * suite needs, and a branch credential is minted per run rather than stored: the gateway
 * token is not a static secret, so parking one in a repository secret would only give it a
 * chance to go stale.
 */
async function mintGatewayToken(
	projectId: string,
	branchId: string,
): Promise<Credential> {
	return apiRequest<Credential>(
		`/projects/${projectId}/branches/${branchId}/credentials`,
		{
			method: "POST",
			body: {
				name: "ai-sdk-provider e2e",
				scopes: ["ai_gateway:invoke"],
				principal_type: "user",
			},
		},
	);
}

async function defaultBranch(projectId: string): Promise<Branch> {
	const { branches } = await apiRequest<{ branches: Branch[] }>(
		`/projects/${projectId}/branches`,
	);
	const branch = branches.find((candidate) => candidate.default);
	if (!branch) {
		throw new Error(`Project ${projectId} has no default branch.`);
	}
	return branch;
}

async function readWriteEndpointHost(
	projectId: string,
	branchId: string,
): Promise<string> {
	const { endpoints } = await apiRequest<{ endpoints: Endpoint[] }>(
		`/projects/${projectId}/endpoints`,
	);
	const endpoint = endpoints.find(
		(candidate) =>
			candidate.branch_id === branchId && candidate.type === "read_write",
	);
	if (!endpoint) {
		throw new Error(
			`Branch ${branchId} has no read-write endpoint, so the gateway host cannot be derived.`,
		);
	}
	return endpoint.host;
}

/**
 * Keep the minted token out of the workflow log. GitHub masks the repository secret the run
 * authenticates with, but it has never seen this token, so nothing redacts it if a stack
 * trace or a future debug line carries it.
 */
function maskInActions(token: string): void {
	if (process.env.GITHUB_ACTIONS !== "true") return;
	process.stdout.write(`::add-mask::${token}\n`);
}

/**
 * Create a throwaway project in the configured org and mint a gateway credential on its
 * default branch. The AI Gateway itself needs no provisioning — it exists on every branch,
 * and model access is granted per account — so this is only about getting a scoped token and
 * the branch's host.
 */
export async function provisionGateway(): Promise<ProvisionedGateway> {
	requireApiKey();
	const { swept } = await sweepOrphans();
	if (swept.length > 0) {
		console.warn(
			`[gateway e2e] swept ${swept.length} orphaned project(s) from a previous run.`,
		);
	}
	const projectId = await createProject({
		name: uniqueProjectName("gateway"),
	});
	// Past this point the project exists, so anything that throws has to take it back down:
	// the orphan sweep only reclaims projects older than an hour, so a leak here would sit in
	// the org for that long.
	try {
		const branch = await defaultBranch(projectId);
		const host = await readWriteEndpointHost(projectId, branch.id);
		const credential = await mintGatewayToken(projectId, branch.id);
		maskInActions(credential.api_token);
		return {
			baseUrl: gatewayBaseUrl(branch.id, host),
			token: credential.api_token,
			projectId,
			branchId: branch.id,
			tokenId: credential.token_id,
		};
	} catch (err) {
		await deleteProject(projectId).catch((cleanupErr: unknown) => {
			console.error(
				`[gateway e2e] failed to delete ${projectId} after provisioning failed: ${describeError(cleanupErr)}`,
			);
		});
		throw err;
	}
}

/**
 * Revoke the credential, then delete the project. Deleting the project invalidates the
 * credential anyway, so the explicit revoke exists for the case where deletion fails — which
 * is why a failed revoke must not stop the delete.
 */
export async function releaseGateway(
	gateway: ProvisionedGateway,
): Promise<void> {
	try {
		await apiRequest(
			`/projects/${gateway.projectId}/branches/${gateway.branchId}/credentials/${gateway.tokenId}`,
			{ method: "DELETE" },
		);
	} catch (err) {
		const status = statusOf(err);
		if (status !== 404 && status !== 410) {
			console.error(
				`[gateway e2e] failed to revoke credential ${gateway.tokenId}: ${describeError(err)}`,
			);
		}
	}
	await deleteProject(gateway.projectId);
}
