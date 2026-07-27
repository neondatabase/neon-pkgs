import { randomUUID } from "node:crypto";
import { apiRequest, sleep, statusOf } from "./api.js";
import { configuredOrgId } from "./env.js";

/**
 * Every e2e-created project is named `neon-ts-e2e-<uuid>`. The prefix is what makes
 * automated cleanup safe: {@link deleteProject} refuses to touch anything else.
 */
export const PROJECT_PREFIX = "neon-ts-e2e-";

/**
 * Projects younger than this are assumed to belong to a run that is still in flight. CI
 * runs several suites against one shared org, so {@link sweepOrphans} must never delete a
 * sibling run's project out from under it. Comfortably longer than a full suite.
 */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/** Default Neon region used by every e2e test that creates a project. */
export const DEFAULT_REGION = "aws-us-east-2";

/** Generate a project name guaranteed not to collide with anything else in the org. */
export function uniqueProjectName(suffix?: string): string {
	const id = randomUUID().slice(0, 8);
	return suffix
		? `${PROJECT_PREFIX}${id}-${suffix}`
		: `${PROJECT_PREFIX}${id}`;
}

interface ProjectSummary {
	id: string;
	name: string;
	created_at: string;
}

interface BranchSummary {
	id: string;
	protected: boolean;
}

interface OperationSummary {
	status: string;
}

/** Neon operation states that will never change again. */
const TERMINAL_OPERATION_STATUSES = new Set([
	"finished",
	"failed",
	"error",
	"cancelled",
	"skipped",
]);

/**
 * Discriminates the key currently configured. Project-scoped keys can't list projects;
 * org/user-scoped keys can.
 */
export type ApiKeyScope =
	| { kind: "org-or-user"; canCreate: true }
	| { kind: "project"; projectId: string; canCreate: false };

/**
 * Probe the configured API key to find out what it can do. Memoised because we only need
 * to do this once per process.
 */
let cachedScope: ApiKeyScope | undefined;
export async function detectApiKeyScope(): Promise<ApiKeyScope> {
	if (cachedScope) return cachedScope;
	try {
		await listProjectsPage({ limit: 1 });
		cachedScope = { kind: "org-or-user", canCreate: true };
		return cachedScope;
	} catch (err) {
		const status = statusOf(err);
		if (status !== 401 && status !== 403) throw err;
	}
	const fixedProjectId = process.env.NEON_PROJECT_ID;
	if (!fixedProjectId || fixedProjectId.trim() === "") {
		throw new Error(
			"API key cannot list projects (looks project-scoped) and NEON_PROJECT_ID is not set. " +
				"Set NEON_PROJECT_ID to target a fixed project for the bounded e2e subset.",
		);
	}
	cachedScope = {
		kind: "project",
		projectId: fixedProjectId,
		canCreate: false,
	};
	return cachedScope;
}

function listProjectsPage(query: { limit: number; cursor?: string }): Promise<{
	projects: ProjectSummary[];
	pagination?: { next?: string };
}> {
	return apiRequest("/projects", {
		query: { ...query, org_id: configuredOrgId() },
	});
}

/**
 * Create a project in the configured org and wait until it is actually usable. Packages
 * that exercise their own creation path (`@neon/config`'s `NeonApi` adapter, say) should
 * use that instead — this exists for suites whose subject under test isn't project
 * creation.
 *
 * The wait is not optional on purpose. "Created" and "usable" are different states: Neon
 * rejects the next mutation with "project already has running conflicting operations"
 * while provisioning is still in flight, and a helper that hands back an id you can't use
 * yet just moves that race into every caller.
 */
export async function createProject(args: {
	name: string;
	region?: string;
}): Promise<string> {
	const body = await apiRequest<{ project: ProjectSummary }>("/projects", {
		method: "POST",
		body: {
			project: {
				name: args.name,
				region_id: args.region ?? DEFAULT_REGION,
				...(configuredOrgId() ? { org_id: configuredOrgId() } : {}),
			},
		},
	});
	await waitForProjectReady(body.project.id);
	return body.project.id;
}

/**
 * Poll until the project has no operation left in a non-terminal state. Returns rather
 * than throwing on timeout: the caller's own assertion is a better failure message than
 * one from a setup helper.
 */
export async function waitForProjectReady(
	projectId: string,
	timeoutMs = 120_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const body = await apiRequest<{ operations: OperationSummary[] }>(
			`/projects/${projectId}/operations`,
		);
		const pending = body.operations.filter(
			(operation) => !TERMINAL_OPERATION_STATUSES.has(operation.status),
		);
		if (pending.length === 0) return;
		await sleep(500);
	}
}

/**
 * Delete a project, ignoring "already gone" errors so cleanup is idempotent. Refuses to
 * delete anything that isn't prefixed with {@link PROJECT_PREFIX} so a mis-typed id can
 * never wipe an unrelated project.
 */
export async function deleteProject(projectId: string): Promise<void> {
	const project = await apiRequest<{ project: ProjectSummary }>(
		`/projects/${projectId}`,
	).catch((err: unknown) => {
		const status = statusOf(err);
		if (status === 404 || status === 410) return null;
		throw err;
	});
	if (!project) return;
	if (!project.project.name.startsWith(PROJECT_PREFIX)) {
		throw new Error(
			`Refusing to delete project ${projectId} ("${project.project.name}"): does not match the e2e prefix.`,
		);
	}
	// Retry on 423 (locked while a previous mutation is in flight) so cleanup is robust.
	// A 422 means a branch is still protected; clear the flag once and try again.
	const maxAttempts = 12;
	let delay = 500;
	let unprotected = false;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
			return;
		} catch (err) {
			const status = statusOf(err);
			if (status === 404 || status === 410) return;
			if (status === 422 && !unprotected) {
				unprotected = true;
				await unprotectBranches(projectId);
				continue;
			}
			if (status !== 423 || attempt === maxAttempts) throw err;
			await sleep(delay);
			delay = Math.min(delay * 2, 5_000);
		}
	}
}

/**
 * Neon refuses to delete a project while any of its branches is protected, and
 * `@neon/config-runtime`'s lifecycle test leaves the default branch that way on purpose.
 * Without clearing the flag the project is undeletable — not just by the test that made
 * it, but by {@link sweepOrphans} too, so it would sit in the org forever.
 */
async function unprotectBranches(projectId: string): Promise<void> {
	const body = await apiRequest<{ branches: BranchSummary[] }>(
		`/projects/${projectId}/branches`,
	);
	for (const branch of body.branches) {
		if (!branch.protected) continue;
		await apiRequest(`/projects/${projectId}/branches/${branch.id}`, {
			method: "PATCH",
			body: { branch: { protected: false } },
		});
	}
}

/**
 * List every project whose name starts with {@link PROJECT_PREFIX} and is older than
 * {@link ORPHAN_MIN_AGE_MS}, then delete them. Called once at suite start to mop up
 * orphans from a previous failed run without touching a concurrent run's projects.
 */
export async function sweepOrphans(): Promise<{ swept: string[] }> {
	const scope = await detectApiKeyScope();
	if (scope.kind === "project") return { swept: [] };
	const swept: string[] = [];
	const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
	let cursor: string | undefined;
	while (true) {
		const body = await listProjectsPage({ limit: 100, cursor });
		for (const project of body.projects) {
			if (!project.name.startsWith(PROJECT_PREFIX)) continue;
			if (Date.parse(project.created_at) > cutoff) continue;
			await deleteProject(project.id);
			swept.push(project.id);
		}
		const next = body.pagination?.next;
		if (!next || next === cursor) break;
		cursor = next;
	}
	return { swept };
}
