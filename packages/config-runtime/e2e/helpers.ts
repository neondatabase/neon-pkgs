import { randomUUID } from "node:crypto";
import { createRealNeonApi, type NeonApi } from "@neon/config";
import { createNeonClient } from "@neon/sdk";
import {
	deleteProject as rawDeleteProject,
	getProject as rawGetProject,
	listProjects as rawListProjects,
} from "@neon/sdk/raw";
import { test } from "vitest";

/**
 * Every e2e-created project is named `neon-ts-e2e-<uuid>`. Tests can register
 * `track(id)` to opt into the per-test cleanup hook. The suite-level
 * {@link sweepOrphans} additionally deletes leftovers from a previous failed run.
 */
const PROJECT_PREFIX = "neon-ts-e2e-";

/**
 * Default Neon region used by every e2e test that creates a project. Override per-test
 * by passing `region` to `defineConfig`.
 */
export const DEFAULT_REGION = "aws-us-east-2";

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
	const created = await api.createProject({
		name: args.name,
		regionId: args.region,
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
	if (!response || !response.ok) {
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
		unwrap(await rawListProjects({ client, query: { limit: 1 } }));
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
		.catch((err: unknown) => {
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
	const maxAttempts = 12;
	let delay = 500;
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
			if (status !== 423 || attempt === maxAttempts) throw err;
			await sleep(delay);
			delay = Math.min(delay * 2, 5_000);
		}
	}
}

/**
 * List every project whose name starts with {@link PROJECT_PREFIX} and delete them.
 * Called once at suite start to mop up orphans from a previous failed run.
 */
export async function sweepOrphans(): Promise<{ swept: string[] }> {
	const scope = await detectApiKeyScope();
	if (scope.kind === "project") return { swept: [] };
	const client = makeRawClient();
	const swept: string[] = [];
	let cursor: string | undefined;
	while (true) {
		const body = unwrap(
			await rawListProjects({
				client,
				query: { limit: 100, ...(cursor ? { cursor } : {}) },
			}),
		);
		for (const project of body.projects) {
			if (project.name.startsWith(PROJECT_PREFIX)) {
				await deleteProject(project.id);
				swept.push(project.id);
			}
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
					`[e2e cleanup] failed to delete ${projectId}: ${(err as Error).message}`,
				);
			}
		}
	},
});

/**
 * Some Neon operations are eventually consistent (notably branch creation finishing
 * `init` → `ready`). A small wait avoids racing on subsequent reads.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
