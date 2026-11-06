import { NeonApiError, type NeonClient } from "@neon/sdk";
import { listSharedProjects } from "@neon/sdk/raw";
import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";
import { matchesNameOrId } from "./organizations.js";

const DEFAULT_API_BASE_URL = "https://console.neon.tech/api/v2";
const PROJECTS_PER_ORGANIZATION = 400;

export const searchResourcesInputSchema = z.strictObject({
	query: z
		.string()
		.min(3)
		.describe(
			"The search query to find matching organizations, projects, or branches",
		),
});

type SearchResult = {
	id: string;
	title: string;
	url: string;
	type: "organization" | "project" | "branch";
};

export const consoleBaseUrl = (apiBaseUrl: string) =>
	apiBaseUrl.replace(/\/api\/v2\/?$/, "");

/** An inaccessible organization, project, or branch is left out of the results; anything else fails the search. */
const skipIfRefused = async <T>(read: () => Promise<T[]>): Promise<T[]> => {
	try {
		return await read();
	} catch (error) {
		if (error instanceof NeonApiError) return [];
		throw error;
	}
};

const searchResources = async (
	neon: NeonClient<true>,
	query: string,
	consoleUrl: string,
	signal?: AbortSignal,
): Promise<SearchResult[]> => {
	const link = (path: string) => new URL(path, consoleUrl).toString();

	const searchProjects = async (
		projects: readonly { id: string; name: string }[],
	): Promise<SearchResult[]> => {
		const matchingProjects = projects
			.filter((project) => matchesNameOrId(project, query))
			.map((project) => ({
				id: `project:${project.id}`,
				title: project.name,
				url: link(`/app/projects/${encodeURIComponent(project.id)}`),
				type: "project" as const,
			}));
		const branches = await Promise.all(
			projects.map((project) =>
				skipIfRefused(async () => {
					const page = await neon.branches
						.list({ projectId: project.id }, { signal })
						.page();
					return page.items
						.filter((branch) => matchesNameOrId(branch, query))
						.map((branch) => ({
							id: `branch:${project.id}/${branch.id}`,
							title: branch.name,
							url: link(
								`/app/projects/${encodeURIComponent(project.id)}/branches/${encodeURIComponent(branch.id)}`,
							),
							type: "branch" as const,
						}));
				}),
			),
		);
		return [...matchingProjects, ...branches.flat()];
	};

	const results: SearchResult[] = [];
	for (const org of await neon.user.organizations({ signal })) {
		if (matchesNameOrId(org, query)) {
			results.push({
				id: `org:${org.id}`,
				title: org.name,
				url: link(`/app/${encodeURIComponent(org.id)}/projects`),
				type: "organization",
			});
		}
		results.push(
			...(await skipIfRefused(async () => {
				const page = await neon.projects
					.list(
						{ org_id: org.id, limit: PROJECTS_PER_ORGANIZATION },
						{ signal },
					)
					.page();
				return searchProjects(page.items);
			})),
		);
	}
	results.push(
		...(await skipIfRefused(async () => {
			const shared = await listSharedProjects({
				client: neon.client,
				query: { limit: PROJECTS_PER_ORGANIZATION },
				throwOnError: true,
				signal,
			});
			return searchProjects(shared.projects);
		})),
	);
	return results;
};

export const searchResourcesTool = (options: ToolClientOptions) => {
	const consoleUrl = consoleBaseUrl(options.baseUrl ?? DEFAULT_API_BASE_URL);
	return bindTool(
		options,
		{
			operationId: "resources.search",
			id: publishedId("resources.search"),
			title: "Search organizations, projects, and branches",
			description:
				"Search across all organizations, projects, and branches the credential can access, including projects shared with the user, by keyword. Matches names and ids case-insensitively. Returns matching items with id, title, console URL, and type. Query must be at least 3 characters.",
			inputSchema: searchResourcesInputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			requiresApproval: false,
			metadata: {
				method: "GET",
				path: "/projects",
				stability: "stable",
				deprecated: false,
				tags: ["Project"],
			},
		},
		(neon, input, signal) =>
			searchResources(
				neon,
				input.query.toLowerCase(),
				consoleUrl,
				signal,
			),
	);
};
