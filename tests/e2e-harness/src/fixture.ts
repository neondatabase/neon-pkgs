import { beforeAll, test } from "vitest";
import { describeError } from "./api.js";
import { deleteProject, detectApiKeyScope, sweepOrphans } from "./projects.js";

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
 * Suite-level setup, registered from a package's e2e setup file. Probing the key here
 * means a misconfigured environment fails fast with a clear message instead of surfacing
 * as cryptic 403s inside individual tests.
 */
export function installSuiteSetup(): void {
	beforeAll(async () => {
		const scope = await detectApiKeyScope();
		if (scope.kind !== "org-or-user") return;
		const { swept } = await sweepOrphans();
		if (swept.length > 0) {
			console.warn(
				`[e2e setup] swept ${swept.length} orphaned project(s) from a previous run.`,
			);
		}
	});
}
