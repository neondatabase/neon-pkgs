import { apiRequest, describeError, statusOf } from "./api.js";
import { requireApiKey } from "./env.js";
import {
	createProject,
	deleteProject,
	sweepOrphans,
	uniqueProjectName,
} from "./projects.js";

/**
 * Neon Auth provisioning, spoken to the Management API with the harness's own `fetch`
 * like everything else here. Paths, payloads and responses mirror the generated client
 * (`packages/sdk/src/client/{types,sdk}.gen.ts`), which is the spec of record:
 * `POST …/auth` takes `EnableNeonAuthIntegrationRequest` and answers 201 with
 * `NeonAuthCreateIntegrationResponse`; `PATCH …/auth/email_and_password` takes
 * `NeonAuthEmailAndPasswordConfigUpdate`; `DELETE …/auth` is `DisableNeonAuthData`.
 */

/** A live Neon Auth integration the suite provisioned for itself. */
export interface ProvisionedNeonAuth {
	projectId: string;
	branchId: string;
	/** What an application knows as `NEON_AUTH_BASE_URL`. */
	baseUrl: string;
	jwksUrl: string;
	schemaName: string;
	tableName: string;
}

/** Only the fields the suite reads, out of `NeonAuthCreateIntegrationResponse`. */
interface EnableAuthResponse {
	base_url?: string;
	jwks_url: string;
	schema_name: string;
	table_name: string;
}

interface Branch {
	id: string;
	default?: boolean;
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

/**
 * Enable Neon Auth with the Better Auth provider. `base_url` is optional in the API
 * (`NeonAuthCreateIntegrationResponse.base_url?`), but the suite has no fallback when the
 * field is absent — every test would hammer a URL nobody knows — so it fails loudly here
 * instead of limping on.
 */
export async function enableNeonAuth(
	projectId: string,
	branchId: string,
): Promise<EnableAuthResponse> {
	const auth = await apiRequest<EnableAuthResponse>(
		`/projects/${projectId}/branches/${branchId}/auth`,
		{
			method: "POST",
			body: { auth_provider: "better_auth" },
		},
	);
	if (!auth.base_url) {
		throw new Error(
			`Enabling Neon Auth on project ${projectId} returned no base_url, which the ` +
				`e2e suite cannot proceed without. Full response: ${JSON.stringify(auth)}`,
		);
	}
	return auth;
}

/**
 * Make headless signup possible: with verification on, email+password signups wait for
 * a verification link no test can click. `disable_sign_up: false` is restated so a
 * console tweak on the throwaway org can never silently block the suite.
 */
export async function configureEmailPassword(
	projectId: string,
	branchId: string,
): Promise<void> {
	await apiRequest(
		`/projects/${projectId}/branches/${branchId}/auth/email_and_password`,
		{
			method: "PATCH",
			body: {
				require_email_verification: false,
				disable_sign_up: false,
			},
		},
	);
}

/**
 * Trust localhost origins. Better Auth refuses a relative `callbackURL` unless the request
 * carries a trusted `Origin`, and headless clients send none, so the suite supplies a
 * localhost one (`ORIGIN` in `packages/auth/e2e/helpers.ts`) that this makes acceptable.
 * Shape per `UpdateNeonAuthAllowLocalhostRequest`.
 */
export async function allowLocalhostOrigins(
	projectId: string,
	branchId: string,
): Promise<void> {
	await apiRequest(
		`/projects/${projectId}/branches/${branchId}/auth/allow_localhost`,
		{ method: "PATCH", body: { allow_localhost: true } },
	);
}

/** Disable the integration and drop the `neon_auth` schema it provisioned. */
export async function disableNeonAuth(
	projectId: string,
	branchId: string,
): Promise<void> {
	await apiRequest(`/projects/${projectId}/branches/${branchId}/auth`, {
		method: "DELETE",
		body: { delete_data: true },
	});
}

/**
 * Create a throwaway project and put a headless-signup-enabled Neon Auth service on its
 * default branch. Anything that throws after `createProject` has to take the project
 * back down: the orphan sweep only reclaims projects older than an hour.
 */
export async function provisionNeonAuth(): Promise<ProvisionedNeonAuth> {
	requireApiKey();
	const { swept } = await sweepOrphans();
	if (swept.length > 0) {
		console.warn(
			`[auth e2e] swept ${swept.length} orphaned project(s) from a previous run.`,
		);
	}
	const projectId = await createProject({
		name: uniqueProjectName("auth"),
	});
	try {
		const branch = await defaultBranch(projectId);
		const auth = await enableNeonAuth(projectId, branch.id);
		await configureEmailPassword(projectId, branch.id);
		await allowLocalhostOrigins(projectId, branch.id);
		return {
			projectId,
			branchId: branch.id,
			baseUrl: auth.base_url as string,
			jwksUrl: auth.jwks_url,
			schemaName: auth.schema_name,
			tableName: auth.table_name,
		};
	} catch (err) {
		await deleteProject(projectId).catch((cleanupErr: unknown) => {
			console.error(
				`[auth e2e] failed to delete ${projectId} after provisioning failed: ${describeError(cleanupErr)}`,
			);
		});
		throw err;
	}
}

/**
 * Disable the integration, then delete the project. Deleting the project removes the
 * integration anyway, which is why a failed disable must not stop the delete.
 */
export async function releaseNeonAuth(
	provisioned: ProvisionedNeonAuth,
): Promise<void> {
	try {
		await disableNeonAuth(provisioned.projectId, provisioned.branchId);
	} catch (err) {
		const status = statusOf(err);
		if (status !== 404 && status !== 410) {
			console.error(
				`[auth e2e] failed to disable auth on ${provisioned.projectId}: ${describeError(err)}`,
			);
		}
	}
	await deleteProject(provisioned.projectId);
}
