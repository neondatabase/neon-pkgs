import { randomUUID } from "node:crypto";
import { createNeonClient } from "@neon/sdk";
import {
	deleteProject as rawDeleteProject,
	getProject as rawGetProject,
	listProjectBranches as rawListProjectBranches,
	listProjects as rawListProjects,
	updateProjectBranch as rawUpdateProjectBranch,
} from "@neon/sdk/raw";
import { test } from "vitest";
import type { NeonApi } from "../src/lib/neon-api.js";
import { createRealNeonApi } from "../src/lib/neon-api-real.js";

/**
 * Every e2e-created project is named `neon-ts-e2e-<uuid>`. Tests can register
 * `track(id)` to opt into the per-test cleanup hook. The suite-level
 * {@link sweepOrphans} additionally deletes leftovers from a previous failed run.
 */
const PROJECT_PREFIX = "neon-ts-e2e-";

/**
 * Projects younger than this are assumed to belong to a run that is still in flight. CI
 * runs several suites against one shared org, so {@link sweepOrphans} must never delete a
 * sibling run's project out from under it. Comfortably longer than a full suite.
 */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Default Neon region used by every e2e test that creates a project. Override per-test
 * by passing `region` to `defineConfig`.
 */
export const DEFAULT_REGION = "aws-us-east-2";

/**
 * Pins every create and list to one organization. Redundant for an org-scoped API key,
 * which can't see anything else anyway, but essential for a user-scoped key: without it
 * {@link sweepOrphans} would range over every org the user belongs to.
 */
function configuredOrgId(): string | undefined {
	const value = process.env.NEON_ORG_ID?.trim();
	return value ? value : undefined;
}

function orgQuery(): { org_id?: string } {
	const org = configuredOrgId();
	return org ? { org_id: org } : {};
}

/** Generate a project name guaranteed not to collide with anything else in the org. */
export function uniqueProjectName(suffix?: string): string {
	const id = randomUUID().slice(0, 8);
	return suffix
		? `${PROJECT_PREFIX}${id}-${suffix}`
		: `${PROJECT_PREFIX}${id}`;
}

function requireApiKey(): string {
	const key = process.env.NEON_API_KEY;
	if (!key || key.trim() === "") {
		throw new Error(
			"NEON_API_KEY is not set. Create packages/config/.env (see .env.example) before running test:e2e.",
		);
	}
	return key;
}

/** The same real NeonApi adapter the SDK uses internally — exercised end-to-end. */
export function makeRealApi(): NeonApi {
	return createRealNeonApi({ apiKey: requireApiKey() });
}

/**
 * Create a real Neon project via the NeonApi adapter directly. `pushConfig` no longer
 * provisions projects (callers are expected to run `neonctl link` first), so every e2e
 * test that needs a fresh project to push against goes through this helper instead.
 */
export async function bootstrapProject(
	api: NeonApi,
	args: { name: string; region: string },
): Promise<string> {
	const org = configuredOrgId();
	const created = await api.createProject({
		name: args.name,
		regionId: args.region,
		...(org ? { orgId: org } : {}),
	});
	return created.id;
}

/** Lower-level Neon client. Used by cleanup and a few setup helpers. */
function makeRawClient(): ReturnType<typeof createNeonClient>["client"] {
	return createNeonClient({ apiKey: requireApiKey() }).client;
}

/**
 * Unwrap a `@neon/sdk` raw `{ data, error, response }` result into the bare body, throwing
 * `{ response: { status } }` on a non-2xx so the status-based catches below keep working.
 */
function unwrap<T>(result: {
	data?: T;
	error?: unknown;
	response?: Response;
}): T {
	const response = result.response;
	if (!response?.ok) {
		throw { response: { status: response?.status, data: result.error } };
	}
	return result.data as T;
}

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
	const client = makeRawClient();
	try {
		unwrap(
			await rawListProjects({
				client,
				query: { limit: 1, ...orgQuery() },
			}),
		);
		cachedScope = { kind: "org-or-user", canCreate: true };
		return cachedScope;
	} catch (err) {
		const status = (err as { response?: { status?: number } } | undefined)
			?.response?.status;
		if (status !== 401 && status !== 403) throw err;
	}
	const fixedProjectId = process.env.NEON_PROJECT_ID;
	if (!fixedProjectId || fixedProjectId.trim() === "") {
		throw new Error(
			"API key cannot list projects (looks project-scoped) and NEON_PROJECT_ID is not set. " +
				"Set NEON_PROJECT_ID in packages/config/.env to target a fixed project for the bounded e2e subset.",
		);
	}
	cachedScope = {
		kind: "project",
		projectId: fixedProjectId,
		canCreate: false,
	};
	return cachedScope;
}

/**
 * Delete a project, ignoring "already gone" errors so cleanup is idempotent. Refuses to
 * delete anything that isn't prefixed with {@link PROJECT_PREFIX} so a mis-typed id can
 * never wipe an unrelated project.
 */
async function deleteProject(projectId: string): Promise<void> {
	const client = makeRawClient();
	const project = await rawGetProject({
		client,
		path: { project_id: projectId },
	})
		.then(unwrap)
		.catch((err) => {
			const status = (
				err as { response?: { status?: number } } | undefined
			)?.response?.status;
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
			unwrap(
				await rawDeleteProject({
					client,
					path: { project_id: projectId },
				}),
			);
			return;
		} catch (err) {
			const status = (
				err as { response?: { status?: number } } | undefined
			)?.response?.status;
			if (status === 404 || status === 410) return;
			if (status === 422 && !unprotected) {
				unprotected = true;
				await unprotectBranches(client, projectId);
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
async function unprotectBranches(
	client: ReturnType<typeof makeRawClient>,
	projectId: string,
): Promise<void> {
	const body = unwrap(
		await rawListProjectBranches({
			client,
			path: { project_id: projectId },
		}),
	);
	for (const branch of body.branches) {
		if (!branch.protected) continue;
		unwrap(
			await rawUpdateProjectBranch({
				client,
				path: { project_id: projectId, branch_id: branch.id },
				body: { branch: { protected: false } },
			}),
		);
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
	const client = makeRawClient();
	const swept: string[] = [];
	const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
	let cursor: string | undefined;
	while (true) {
		const body = unwrap(
			await rawListProjects({
				client,
				query: {
					limit: 100,
					...orgQuery(),
					...(cursor ? { cursor } : {}),
				},
			}),
		);
		for (const project of body.projects) {
			if (!project.name.startsWith(PROJECT_PREFIX)) continue;
			if (Date.parse(project.created_at) > cutoff) continue;
			await deleteProject(project.id);
			swept.push(project.id);
		}
		const next = (body as { pagination?: { next?: string } }).pagination
			?.next;
		if (!next || next === cursor) break;
		cursor = next;
	}
	return { swept };
}

/**
 * A vitest `test.extend` fixture that tracks every project id a test creates and deletes
 * each one in the cleanup phase, even if the test failed mid-way. Use `track(id)` to
 * register ids — cleanup runs regardless of outcome.
 */
export const e2eTest = test.extend<{
	track: (projectId: string) => void;
}>({
	// biome-ignore lint/correctness/noEmptyPattern: vitest's fixture API requires this exact shape.
	track: async ({}, use) => {
		const created: string[] = [];
		await use((projectId: string) => {
			created.push(projectId);
		});
		for (const projectId of created) {
			try {
				await deleteProject(projectId);
			} catch (err) {
				// Surface, but don't fail on cleanup errors — the orphan sweep on the next
				// run will mop up anything we miss.
				console.error(
					`[e2e cleanup] failed to delete ${projectId}: ${describeError(err)}`,
				);
			}
		}
	},
});

/**
 * {@link unwrap} throws a bare `{ response: { status } }`, not an `Error`, so reading
 * `.message` off it reports `undefined` and hides why cleanup failed.
 */
function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	const status = (err as { response?: { status?: number } } | undefined)
		?.response?.status;
	return status ? `HTTP ${status}` : String(err);
}

/**
 * Some Neon operations are eventually consistent (notably branch creation finishing
 * `init` → `ready`). A small wait avoids racing on subsequent reads.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
