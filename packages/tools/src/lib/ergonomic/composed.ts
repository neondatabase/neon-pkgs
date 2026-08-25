import * as z from "zod";
import * as zod from "../../generated/zod.gen.js";
import { bindTool, publishedId, type ToolClientOptions } from "./bind.js";

const writeAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	openWorldHint: true,
} as const;

const readAnnotations = {
	readOnlyHint: true,
	openWorldHint: true,
} as const;

const pooledField = z
	.boolean()
	.describe(
		"Return a pooled connection string. Default true. Set false for a direct connection.",
	)
	.optional();

const branchCreateFields = zod.zBranchCreateRequest.shape.branch.unwrap().shape;
const projectCreateFields = zod.zCreateProjectBody.shape.project.shape;

export const createBranchWithComputeInputSchema = z.strictObject({
	project_id: zod.zCreateProjectBranchPath.shape.project_id,
	name: branchCreateFields.name,
	parent_id: branchCreateFields.parent_id,
	compute: z
		.strictObject({
			min_cu: zod.zComputeUnit.optional(),
			max_cu: zod.zComputeUnit.optional(),
			suspend_timeout_seconds: zod.zSuspendTimeoutSeconds.optional(),
		})
		.optional(),
	pooled: pooledField,
});

export const createProjectAndConnectInputSchema = z.strictObject({
	...projectCreateFields,
	pooled: pooledField,
});

export const getDefaultInputSchema = z.strictObject({
	project_id: zod.zListProjectBranchesPath.shape.project_id,
});

export const resetFromParentInputSchema = z.strictObject({
	project_id: zod.zRestoreProjectBranchPath.shape.project_id,
	branch_id: zod.zRestoreProjectBranchPath.shape.branch_id,
	preserve_under_name: zod.zBranchRestoreRequest.shape.preserve_under_name,
});

const compareQuery = zod.zGetProjectBranchSchemaComparisonQuery.shape;

export const compareSchemaInputSchema = z.strictObject({
	project_id: zod.zGetProjectBranchSchemaComparisonPath.shape.project_id,
	branch_id: zod.zGetProjectBranchSchemaComparisonPath.shape.branch_id,
	database_name: compareQuery.db_name,
	base_branch_id: compareQuery.base_branch_id,
	lsn: compareQuery.lsn,
	timestamp: compareQuery.timestamp,
	base_lsn: compareQuery.base_lsn,
	base_timestamp: compareQuery.base_timestamp,
});

export const connectionStringInputSchema = z.strictObject({
	project_id: zod.zGetConnectionUriPath.shape.project_id,
	branch_id: zod.zGetConnectionUriQuery.shape.branch_id,
	endpoint_id: zod.zGetConnectionUriQuery.shape.endpoint_id,
	database_name: zod.zGetConnectionUriQuery.shape.database_name,
	role_name: zod.zGetConnectionUriQuery.shape.role_name,
	pooled: pooledField,
});

export const restoreSnapshotInputSchema = z.strictObject({
	project_id: zod.zRestoreSnapshotPath.shape.project_id,
	snapshot_id: zod.zRestoreSnapshotPath.shape.snapshot_id,
	name: zod.zRestoreSnapshotBody.shape.name,
	target_branch_id: zod.zRestoreSnapshotBody.shape.target_branch_id,
	finalize: z
		.boolean()
		.describe(
			"Finalize immediately (move computes onto the restored branch). Defaults to true when restoring as a new branch and false when restoring onto an existing branch.",
		)
		.optional(),
});

const snapshotFrequency = z.enum(["daily", "weekly", "monthly"]);

export const setScheduleInputSchema = z.strictObject({
	project_id: zod.zSetSnapshotSchedulePath.shape.project_id,
	branch_id: zod.zSetSnapshotSchedulePath.shape.branch_id,
	schedule: z.array(
		z.strictObject({
			...zod.zBackupScheduleItem.shape,
			frequency: snapshotFrequency,
		}),
	),
});

export const createBranchWithComputeTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "branches.createWithCompute",
			id: publishedId("branches.createWithCompute"),
			title: "Create branch with compute",
			description:
				"Create a branch with a read-write endpoint and return its connection string. The call waits until operation-backed provisioning finishes, up to five minutes by default.",
			inputSchema: createBranchWithComputeInputSchema,
			annotations: writeAnnotations,
			requiresApproval: true,
			metadata: {
				method: "POST",
				path: "/projects/{project_id}/branches",
				stability: "stable",
				deprecated: false,
				tags: ["Branch"],
			},
		},
		(neon, input, signal) =>
			neon.branches.createWithCompute(
				input.project_id,
				{
					name: input.name,
					parentId: input.parent_id,
					compute:
						input.compute === undefined
							? undefined
							: {
									minCu: input.compute.min_cu,
									maxCu: input.compute.max_cu,
									suspendTimeoutSeconds:
										input.compute.suspend_timeout_seconds,
								},
				},
				{
					signal,
					...(input.pooled === undefined
						? {}
						: { pooled: input.pooled }),
				},
			),
	);

export const createProjectAndConnectTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "projects.createAndConnect",
			id: publishedId("projects.createAndConnect"),
			title: "Create project and connect",
			description:
				"Create a project and return a connection string to its default branch. The call waits until operation-backed provisioning finishes, up to five minutes by default.",
			inputSchema: createProjectAndConnectInputSchema,
			annotations: writeAnnotations,
			requiresApproval: true,
			metadata: {
				method: "POST",
				path: "/projects",
				stability: "stable",
				deprecated: false,
				tags: ["Project"],
			},
		},
		(neon, input, signal) => {
			const { pooled, ...project } = input;
			return neon.projects.createAndConnect(project, {
				signal,
				...(pooled === undefined ? {} : { pooled }),
			});
		},
	);

export const getDefaultTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "branches.getDefault",
			id: publishedId("branches.getDefault"),
			title: "Get default branch",
			description:
				"Resolve the project's default branch by the default flag, not by name.",
			inputSchema: getDefaultInputSchema,
			annotations: readAnnotations,
			requiresApproval: false,
			metadata: {
				method: "GET",
				path: "/projects/{project_id}/branches",
				stability: "stable",
				deprecated: false,
				tags: ["Branch"],
			},
		},
		(neon, input, signal) =>
			neon.branches.getDefault(input.project_id, { signal }),
	);

export const resetFromParentTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "branches.resetFromParent",
			id: publishedId("branches.resetFromParent"),
			title: "Reset branch from parent",
			description:
				"Reset a branch to its parent's current HEAD. preserve_under_name is required when the branch has children. Does not restore to an LSN or timestamp.",
			inputSchema: resetFromParentInputSchema,
			annotations: writeAnnotations,
			requiresApproval: true,
			metadata: {
				method: "POST",
				path: "/projects/{project_id}/branches/{branch_id}/restore",
				stability: "stable",
				deprecated: false,
				tags: ["Branch"],
			},
		},
		(neon, input, signal) =>
			neon.branches.resetFromParent(
				input.project_id,
				input.branch_id,
				input.preserve_under_name === undefined
					? undefined
					: { preserveUnderName: input.preserve_under_name },
				{ signal },
			),
	);

export const compareSchemaTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "branches.compareSchema",
			id: publishedId("branches.compareSchema"),
			title: "Compare database schema",
			description:
				"Compare a branch database schema to another branch. Omitting base_branch_id compares against the parent. Returns a unified SQL diff.",
			inputSchema: compareSchemaInputSchema,
			annotations: readAnnotations,
			requiresApproval: false,
			metadata: {
				method: "GET",
				path: "/projects/{project_id}/branches/{branch_id}/compare_schema",
				stability: "stable",
				deprecated: false,
				tags: ["Branch"],
			},
		},
		(neon, input, signal) =>
			neon.branches.compareSchema(
				input.project_id,
				input.branch_id,
				{
					databaseName: input.database_name,
					...(input.base_branch_id === undefined
						? {}
						: { baseBranchId: input.base_branch_id }),
					...(input.lsn === undefined ? {} : { lsn: input.lsn }),
					...(input.timestamp === undefined
						? {}
						: { timestamp: input.timestamp }),
					...(input.base_lsn === undefined
						? {}
						: { baseLsn: input.base_lsn }),
					...(input.base_timestamp === undefined
						? {}
						: { baseTimestamp: input.base_timestamp }),
				},
				{ signal },
			),
	);

export const connectionStringTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "postgres.connectionString",
			id: publishedId("postgres.connectionString"),
			title: "Get connection string",
			description:
				"Resolve a Postgres connection string. Auto-selects the default branch and the sole role and database when those are omitted. Errors when the selection is ambiguous.",
			inputSchema: connectionStringInputSchema,
			annotations: readAnnotations,
			requiresApproval: true,
			metadata: {
				method: "GET",
				path: "/projects/{project_id}/connection_uri",
				stability: "stable",
				deprecated: false,
				tags: ["Project"],
			},
		},
		(neon, input, signal) =>
			neon.postgres.connectionString(
				{
					projectId: input.project_id,
					...(input.branch_id === undefined
						? {}
						: { branchId: input.branch_id }),
					...(input.endpoint_id === undefined
						? {}
						: { endpointId: input.endpoint_id }),
					...(input.database_name === undefined
						? {}
						: { databaseName: input.database_name }),
					...(input.role_name === undefined
						? {}
						: { roleName: input.role_name }),
					...(input.pooled === undefined
						? {}
						: { pooled: input.pooled }),
				},
				{ signal },
			),
	);

export const restoreSnapshotTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "snapshots.restore",
			id: publishedId("snapshots.restore"),
			title: "Restore snapshot",
			description:
				"Restore a snapshot onto a new or existing branch. The call waits until operation-backed provisioning finishes. Preview callbacks are not available on this tool.",
			inputSchema: restoreSnapshotInputSchema,
			annotations: writeAnnotations,
			requiresApproval: true,
			metadata: {
				method: "POST",
				path: "/projects/{project_id}/snapshots/{snapshot_id}/restore",
				stability: "stable",
				deprecated: false,
				tags: ["Snapshot"],
			},
		},
		(neon, input, signal) =>
			neon.snapshots.restore(
				input.project_id,
				input.snapshot_id,
				{
					name: input.name,
					targetBranchId: input.target_branch_id,
					finalize: input.finalize,
				},
				{ signal },
			),
	);

export const setScheduleTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "snapshots.setSchedule",
			id: publishedId("snapshots.setSchedule"),
			title: "Set snapshot schedule",
			description:
				"Replace a branch's automatic snapshot schedule. Frequency must be daily, weekly, or monthly.",
			inputSchema: setScheduleInputSchema,
			annotations: writeAnnotations,
			requiresApproval: true,
			metadata: {
				method: "PUT",
				path: "/projects/{project_id}/branches/{branch_id}/backup_schedule",
				stability: "stable",
				deprecated: false,
				tags: ["Snapshot"],
			},
		},
		(neon, input, signal) =>
			neon.snapshots.setSchedule(
				input.project_id,
				input.branch_id,
				{ schedule: input.schedule },
				{ signal },
			),
	);
