import * as z from "zod";
import * as zod from "../../generated/zod.gen.js";
import { bindTool, publishedId, type ToolClientOptions } from "./bind.js";

const writeAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	openWorldHint: false,
} as const;

const readAnnotations = {
	readOnlyHint: true,
	openWorldHint: false,
} as const;

const pooledField = z
	.boolean()
	.describe(
		"Return a pooled connection string. Default true. Set false for a direct connection.",
	)
	.optional();

const branchCreateFields = zod.zBranchCreateRequest.shape.branch.unwrap().shape;
const projectCreateFields = zod.zCreateProjectBody.shape.project.shape;

const computeSettingsSchema = z
	.strictObject({
		min_cu: zod.zComputeUnit.optional(),
		max_cu: zod.zComputeUnit.optional(),
		suspend_timeout_seconds: zod.zSuspendTimeoutSeconds.optional(),
	})
	.optional();

const mapCompute = (
	compute:
		| {
				min_cu?: number;
				max_cu?: number;
				suspend_timeout_seconds?: number;
		  }
		| undefined,
) =>
	compute === undefined
		? undefined
		: {
				minCu: compute.min_cu,
				maxCu: compute.max_cu,
				suspendTimeoutSeconds: compute.suspend_timeout_seconds,
			};

const NO_COMPUTE_WITH_COMPUTE =
	"Pass compute settings or no_compute, not both.";

export const createBranchInputSchema = z
	.strictObject({
		project_id: zod.zCreateProjectBranchPath.shape.project_id,
		name: branchCreateFields.name,
		parent_id: branchCreateFields.parent_id,
		compute: computeSettingsSchema,
		no_compute: z
			.boolean()
			.describe(
				"Skip the read-write endpoint. Default false. Cannot be combined with compute.",
			)
			.optional(),
	})
	.superRefine((value, ctx) => {
		if (value.no_compute === true && value.compute !== undefined) {
			ctx.addIssue({
				code: "custom",
				message: NO_COMPUTE_WITH_COMPUTE,
				path: ["no_compute"],
			});
		}
	});

export const createBranchAndConnectInputSchema = z.strictObject({
	project_id: zod.zCreateProjectBranchPath.shape.project_id,
	name: branchCreateFields.name,
	parent_id: branchCreateFields.parent_id,
	compute: computeSettingsSchema,
	pooled: pooledField,
});

export const createProjectInputSchema = z.strictObject({
	...projectCreateFields,
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
	preserve_under_name:
		zod.zBranchRestoreRequest.shape.preserve_under_name.describe(
			"Name under which to save the current branch before the reset. Required when the branch has children; those children move to the new branch.",
		),
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

export const createBranchTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "branches.create",
			id: publishedId("branches.create"),
			title: "Create branch",
			description:
				"Create a branch with a read-write endpoint by default. Pass no_compute to skip the endpoint. The call waits until operation-backed provisioning finishes, up to five minutes by default. Returns branch plus optional endpoints, connectionUris, first endpoint, and pooled connectionString when a compute is created. Use branches.createAndConnect when a URI is required.",
			inputSchema: createBranchInputSchema,
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
		(neon, input, signal) => {
			if (input.no_compute === true) {
				return neon.branches.create(
					input.project_id,
					{
						name: input.name,
						parent_id: input.parent_id,
						noCompute: true,
					},
					{ signal },
				);
			}
			return neon.branches.create(
				input.project_id,
				{
					name: input.name,
					parent_id: input.parent_id,
					compute: mapCompute(input.compute),
				},
				{ signal },
			);
		},
	);

export const createBranchAndConnectTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "branches.createAndConnect",
			id: publishedId("branches.createAndConnect"),
			title: "Create branch and connect",
			description:
				"Create a branch with a read-write endpoint and return its connection string. The call waits until operation-backed provisioning finishes, up to five minutes by default.",
			inputSchema: createBranchAndConnectInputSchema,
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
			neon.branches.createAndConnect(
				input.project_id,
				{
					name: input.name,
					parentId: input.parent_id,
					compute: mapCompute(input.compute),
				},
				{
					signal,
					...(input.pooled === undefined
						? {}
						: { pooled: input.pooled }),
				},
			),
	);

export const createProjectTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "projects.create",
			id: publishedId("projects.create"),
			title: "Create project",
			description:
				"Create a project. The API always provisions a default branch with read-write compute. The call waits until operation-backed provisioning finishes, up to five minutes by default. Does not return a connection string; use projects.createAndConnect or postgres.connectionString for that.",
			inputSchema: createProjectInputSchema,
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
		(neon, input, signal) => neon.projects.create(input, { signal }),
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
				"Reset a branch to its parent's current HEAD. Discards every change the branch has written since it diverged. preserve_under_name is required when the branch has children. For an LSN or timestamp restore, use the raw restoreProjectBranch operation.",
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
