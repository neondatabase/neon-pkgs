import { type NeonClient, NeonClientError, type Paginated } from "@neon/sdk";
import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";
import type { NeonToolExecutionContext } from "../operation.js";
import {
	consoleBaseUrl,
	DEFAULT_API_BASE_URL,
	isAccessRefusal,
} from "./resources.js";
import { describeBranch } from "./sql/describe-branch.js";

export const fetchResourceInputSchema = z.strictObject({
	id: z
		.string()
		.min(1)
		.describe(
			"An id from {{resources.search}}, such as project:<project_id>.",
		),
});

/** The first page only; a list the API refuses is empty. */
const firstPageIfAllowed = async <T>(
	list: Paginated<T, true>,
): Promise<T[]> => {
	try {
		return (await list.page()).items;
	} catch (error) {
		if (isAccessRefusal(error)) return [];
		throw error;
	}
};

const localDate = (value: string) => new Date(value).toLocaleDateString();

const fetchOrganization = async (
	neonClient: NeonClient<true>,
	id: string,
	orgId: string,
	consoleUrl: string,
	signal?: AbortSignal,
) => {
	const organization = await neonClient.organizations.get(
		{ orgId },
		{ signal },
	);
	const [members, projects] = await Promise.all([
		firstPageIfAllowed(
			neonClient.organizations.members.list({ orgId }, { signal }),
		),
		firstPageIfAllowed(
			neonClient.projects.list({ org_id: orgId }, { signal }),
		),
	]);
	const lines = [
		"**Organization Details**",
		"**Basic Information:**",
		`- Name: ${organization.name}`,
		`- ID: ${organization.id}`,
		`- Created: ${localDate(organization.created_at)}`,
		"",
		"**Statistics:**",
		...(members.length > 0 ? [`- Members: ${members.length}`] : []),
		`- Projects: ${projects.length}`,
		"",
		"**Raw Data:**",
		JSON.stringify({ org: organization, members, projects }, null, 2),
		"",
	];
	return {
		id,
		title: organization.name,
		text: lines.join("\n"),
		url: new URL(
			`/app/${encodeURIComponent(organization.id)}/projects`,
			consoleUrl,
		).toString(),
		metadata: { organization, members, projects },
	};
};

const fetchProject = async (
	neonClient: NeonClient<true>,
	id: string,
	projectId: string,
	consoleUrl: string,
	signal?: AbortSignal,
) => {
	const [branchPage, project] = await Promise.all([
		neonClient.branches.list({ projectId }, { signal }).page(),
		neonClient.projects.get({ projectId }, { signal }),
	]);
	const branches = branchPage.items;
	const defaultBranch = branches.find((branch) => branch.default);
	const text = `**Project Details**

**Basic Information:**
- Name: ${project.name}
- ID: ${project.id}
- Region: ${project.region_id}
- PostgreSQL Version: ${project.pg_version}
- Created: ${localDate(project.created_at)}
- Last Updated: ${localDate(project.updated_at)}

**Statistics:**
- Branches: ${branches.length}
- Default Branch: ${defaultBranch?.name} (${defaultBranch?.id})

**Raw Data:**
${JSON.stringify({ project, branches }, null, 2)}
`;
	return {
		id,
		title: project.name,
		text,
		url: new URL(
			`/app/projects/${encodeURIComponent(project.id)}`,
			consoleUrl,
		).toString(),
		metadata: { project, branches },
	};
};

const fetchEndpoint = async (
	neonClient: NeonClient<true>,
	id: string,
	projectId: string,
	endpointId: string,
	consoleUrl: string,
	signal?: AbortSignal,
) => {
	const endpoint = await neonClient.postgres.endpoints.get(
		{ projectId, endpointId },
		{ signal },
	);
	const text = `**Compute Endpoint Details**

- ID: ${endpoint.id}
- Type: ${endpoint.type}
- State: ${endpoint.current_state}
- Host: ${endpoint.host}
- Branch: ${endpoint.branch_id}
- Project: ${endpoint.project_id}
- Region: ${endpoint.region_id}
- Autoscaling: ${endpoint.autoscaling_limit_min_cu}-${endpoint.autoscaling_limit_max_cu} CU

**Raw Data:**
${JSON.stringify(endpoint, null, 2)}
`;
	return {
		id,
		title: `${endpoint.id} (${endpoint.type})`,
		text,
		url: new URL(
			`/app/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(endpoint.branch_id)}`,
			consoleUrl,
		).toString(),
		metadata: { endpoint },
	};
};

const fetchSnapshot = async (
	neonClient: NeonClient<true>,
	id: string,
	projectId: string,
	snapshotId: string,
	consoleUrl: string,
	signal?: AbortSignal,
) => {
	const snapshots = await neonClient.snapshots.list(
		{ projectId },
		{ signal },
	);
	const snapshot = snapshots.find((candidate) => candidate.id === snapshotId);
	if (snapshot === undefined) {
		throw new NeonClientError(
			`Snapshot ${snapshotId} not found in project ${projectId}`,
		);
	}
	const text = `**Snapshot Details**

- Name: ${snapshot.name}
- ID: ${snapshot.id}
- Source branch: ${snapshot.source_branch_id ?? "unknown"}
- Taken at: ${snapshot.timestamp ?? snapshot.lsn ?? "unknown"}

**Raw Data:**
${JSON.stringify(snapshot, null, 2)}
`;
	return {
		id,
		title: snapshot.name,
		text,
		url: new URL(
			`/app/projects/${encodeURIComponent(projectId)}`,
			consoleUrl,
		).toString(),
		metadata: { snapshot },
	};
};

const invalidId = (id: string) =>
	new NeonClientError(
		`Invalid ID format: "${id}". Expected format: org:*, project:*, branch:<project>/<branch>, endpoint:<project>/<endpoint>, or snapshot:<project>/<snapshot>`,
	);

/** `<prefix><project>/<child>`, the form resources.search returns for project-scoped resources. */
const projectScopedId = (id: string, prefix: string): [string, string] => {
	const [projectId, childId, ...rest] = id.slice(prefix.length).split("/");
	if (!projectId || !childId || rest.length > 0) throw invalidId(id);
	return [projectId, childId];
};

export const fetchResource = async (
	neonClient: NeonClient<true>,
	id: string,
	context: NeonToolExecutionContext,
	consoleUrl: string,
	signal?: AbortSignal,
) => {
	if (id.startsWith("org:")) {
		return fetchOrganization(
			neonClient,
			id,
			id.slice("org:".length),
			consoleUrl,
			signal,
		);
	}
	if (id.startsWith("org-")) {
		return fetchOrganization(neonClient, id, id, consoleUrl, signal);
	}
	if (id.startsWith("project:")) {
		return fetchProject(
			neonClient,
			id,
			id.slice("project:".length),
			consoleUrl,
			signal,
		);
	}
	if (id.startsWith("endpoint:")) {
		const [projectId, endpointId] = projectScopedId(id, "endpoint:");
		return fetchEndpoint(
			neonClient,
			id,
			projectId,
			endpointId,
			consoleUrl,
			signal,
		);
	}
	if (id.startsWith("snapshot:")) {
		const [projectId, snapshotId] = projectScopedId(id, "snapshot:");
		return fetchSnapshot(
			neonClient,
			id,
			projectId,
			snapshotId,
			consoleUrl,
			signal,
		);
	}
	if (id.startsWith("branch:")) {
		const [projectId, branchId] = projectScopedId(id, "branch:");
		const { text, console_url, ...metadata } = await describeBranch(
			neonClient,
			{ project_id: projectId, branch_id: branchId },
			context,
			consoleUrl,
			signal,
		);
		return {
			id,
			title: metadata.branch.name,
			text,
			url: console_url,
			metadata,
		};
	}
	throw invalidId(id);
};

export const fetchResourceTool = (options: ToolClientOptions) => {
	const consoleUrl = consoleBaseUrl(options.baseUrl ?? DEFAULT_API_BASE_URL);
	return bindTool(
		options,
		{
			operationId: "resources.fetch",
			id: publishedId("resources.fetch"),
			title: "Fetch",
			description:
				"Returns an organization, project, branch, compute, or snapshot by an id from {{resources.search}}: markdown text, console URL, and records in metadata.",
			inputSchema: fetchResourceInputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			requiresApproval: false,
			metadata: {
				method: "SQL",
				path: "/projects",
				stability: "stable",
				deprecated: false,
				tags: ["Organization", "Project", "Branch"],
			},
		},
		(neonClient, input, signal, context) =>
			fetchResource(neonClient, input.id, context, consoleUrl, signal),
	);
};
