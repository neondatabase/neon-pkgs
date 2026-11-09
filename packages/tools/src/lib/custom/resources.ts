import { NeonApiError, type NeonClient } from "@neon/sdk";
import { listSharedProjects } from "@neon/sdk/raw";
import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";
import { matchesNameOrId } from "./organizations.js";

export const DEFAULT_API_BASE_URL = "https://console.neon.tech/api/v2";
const PROJECTS_PER_ORGANIZATION = 400;

export const searchResourcesInputSchema = z.strictObject({
	query: z
		.string()
		.min(3)
		.describe(
			"Part of a name or id, or a compute endpoint host from a connection string.",
		),
});

type SearchResult = {
	id: string;
	title: string;
	url: string;
};

export const consoleBaseUrl = (apiBaseUrl: string) =>
	apiBaseUrl.replace(/\/api\/v2\/?$/, "");

/** A resource the API refuses to list is left out of the results; anything else fails the search. */
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
): Promise<{ results: SearchResult[] }> => {
	const link = (path: string) => new URL(path, consoleUrl).toString();

	const projectPath = (projectId: string) =>
		`/app/projects/${encodeURIComponent(projectId)}`;
	const branchPath = (projectId: string, branchId: string) =>
		`${projectPath(projectId)}/branches/${encodeURIComponent(branchId)}`;
	// A pooled connection string names `ep-…-pooler.`; the endpoint's own host has no `-pooler`.
	const hostQuery = query.replace("-pooler.", ".");

	const searchProject = async (projectId: string) => {
		const [branches, endpoints, snapshots] = await Promise.all([
			skipIfRefused(async () =>
				(
					await neon.branches.list({ projectId }, { signal }).page()
				).items.filter((branch) => matchesNameOrId(branch, query)),
			),
			skipIfRefused(async () =>
				(
					await neon.postgres.endpoints.list(
						{ projectId },
						{ signal },
					)
				).filter(
					(endpoint) =>
						endpoint.id.toLowerCase().includes(query) ||
						endpoint.host.toLowerCase().includes(hostQuery),
				),
			),
			skipIfRefused(async () =>
				(await neon.snapshots.list({ projectId }, { signal })).filter(
					(snapshot) => matchesNameOrId(snapshot, query),
				),
			),
		]);
		return [
			...branches.map((branch) => ({
				id: `branch:${projectId}/${branch.id}`,
				title: branch.name,
				url: link(branchPath(projectId, branch.id)),
			})),
			...endpoints.map((endpoint) => ({
				id: `endpoint:${projectId}/${endpoint.id}`,
				title: `${endpoint.id} (${endpoint.type})`,
				url: link(branchPath(projectId, endpoint.branch_id)),
			})),
			...snapshots.map((snapshot) => ({
				id: `snapshot:${projectId}/${snapshot.id}`,
				title: snapshot.name,
				url: link(projectPath(projectId)),
			})),
		];
	};

	const searchProjects = async (
		projects: readonly { id: string; name: string }[],
	): Promise<SearchResult[]> => {
		const matchingProjects = projects
			.filter((project) => matchesNameOrId(project, query))
			.map((project) => ({
				id: `project:${project.id}`,
				title: project.name,
				url: link(projectPath(project.id)),
			}));
		const children = await Promise.all(
			projects.map((project) => searchProject(project.id)),
		);
		return [...matchingProjects, ...children.flat()];
	};

	const results: SearchResult[] = [];
	for (const org of await neon.user.organizations({ signal })) {
		if (matchesNameOrId(org, query)) {
			results.push({
				id: `org:${org.id}`,
				title: org.name,
				url: link(`/app/${encodeURIComponent(org.id)}/projects`),
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
	return { results };
};

export const searchResourcesTool = (options: ToolClientOptions) => {
	const consoleUrl = consoleBaseUrl(options.baseUrl ?? DEFAULT_API_BASE_URL);
	return bindTool(
		options,
		{
			operationId: "resources.search",
			id: publishedId("resources.search"),
			title: "Search Neon resources",
			description:
				"Finds organizations, projects (including shared ones), branches, computes, and snapshots whose name or id contains query, with ids for {{resources.fetch}}. To list projects, use {{projects.list}}; for docs, {{docs.search}}.",
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
