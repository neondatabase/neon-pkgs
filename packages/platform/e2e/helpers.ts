import { randomUUID } from "node:crypto";
import { createApiClient } from "@neondatabase/api-client";
import { test } from "vitest";
import type { NeonApi } from "../src/lib/neon-api.js";
import { createRealNeonApi } from "../src/lib/neon-api-real.js";

/**
 * Every e2e-created project is named `neon-ts-e2e-<uuid>`. Tests can register
 * `track(id)` to opt into the per-test cleanup hook. The suite-level
 * {@link sweepOrphans} additionally deletes leftovers from a previous failed run.
 */
export const PROJECT_PREFIX = "neon-ts-e2e-";

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

export function requireApiKey(): string {
	const key = process.env.NEON_API_KEY;
	if (!key || key.trim() === "") {
		throw new Error(
			"NEON_API_KEY is not set. Create packages/platform/.env (see .env.example) before running test:e2e.",
		);
	}
	return key;
}

/** The same real NeonApi adapter the SDK uses internally — exercised end-to-end. */
export function makeRealApi(): NeonApi {
	return createRealNeonApi({ apiKey: requireApiKey() });
}

/** Lower-level Neon client. Used by cleanup and a few setup helpers. */
export function makeRawClient(): ReturnType<typeof createApiClient> {
	return createApiClient({ apiKey: requireApiKey() });
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
		await client.listProjects({ limit: 1 });
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
				"Set NEON_PROJECT_ID in packages/platform/.env to target a fixed project for the bounded e2e subset.",
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
export async function deleteProject(projectId: string): Promise<void> {
	const client = makeRawClient();
	const project = await client.getProject(projectId).catch((err) => {
		const status = (err as { response?: { status?: number } } | undefined)
			?.response?.status;
		if (status === 404 || status === 410) return null;
		throw err;
	});
	if (!project) return;
	if (!project.data.project.name.startsWith(PROJECT_PREFIX)) {
		throw new Error(
			`Refusing to delete project ${projectId} ("${project.data.project.name}"): does not match the e2e prefix.`,
		);
	}
	// Retry on 423 (locked while a previous mutation is in flight) so cleanup is robust.
	const maxAttempts = 12;
	let delay = 500;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await client.deleteProject(projectId);
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
		const res = await client.listProjects({
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		for (const project of res.data.projects) {
			if (project.name.startsWith(PROJECT_PREFIX)) {
				await deleteProject(project.id);
				swept.push(project.id);
			}
		}
		const next = (res.data as { pagination?: { next?: string } }).pagination
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
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
