import {
	configuredBaseUrl,
	configuredOrgId,
	requireApiKey,
} from "@neon/e2e-harness";
import { deleteProject } from "@neon/e2e-harness/projects";
import { Effect, Stream } from "effect";
import { make, type NeonEffectConfig } from "../src/index.js";

export {
	createProject,
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	uniqueProjectName,
} from "@neon/e2e-harness";

export function config(
	overrides: Partial<NeonEffectConfig> = {},
): NeonEffectConfig {
	return {
		apiKey: requireApiKey(),
		orgId: configuredOrgId(),
		baseUrl: configuredBaseUrl(),
		...overrides,
	};
}

/**
 * Delete every project carrying one of `names`. The harness deletes only ids passed to
 * `track`, and a create that fails after the API accepted it never returns an id; its
 * age also keeps it out of the next run's orphan sweep.
 */
export async function deleteProjectsNamed(names: string[]): Promise<void> {
	const neon = make(config());
	for (const name of names) {
		const projects = await Effect.runPromise(
			neon.projects.list({ search: name }).pipe(Stream.runCollect),
		);
		for (const project of projects) {
			if (project.name === name) await deleteProject(project.id);
		}
	}
}
