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

const roleCreateFields = zod.zCreateProjectBranchRoleBody.shape.role.shape;

const ACCESS_FIELDS_NEED_SCOPED_ACCESS =
	"database_name and schemas apply only to access read_only or read_write.";

export const createRoleInputSchema = z
	.strictObject({
		project_id: zod.zCreateProjectBranchRolePath.shape.project_id,
		branch_id: zod.zCreateProjectBranchRolePath.shape.branch_id,
		name: roleCreateFields.name,
		no_login: roleCreateFields.no_login,
		access: z
			.enum(["admin", "read_only", "read_write"])
			.describe(
				"What the role may do. Default admin: the role joins neon_superuser. read_only: SELECT. read_write: SELECT, INSERT, UPDATE, DELETE and sequence use. Scoped roles get no DDL.",
			)
			.optional(),
		database_name: z
			.string()
			.min(1)
			.describe(
				"Database a read_only or read_write role is scoped to. Optional when the branch has exactly one database.",
			)
			.optional(),
		schemas: z
			.array(z.string().min(1))
			.min(1)
			.describe(
				'Schemas a read_only or read_write role can use. Default ["public"].',
			)
			.optional(),
	})
	.superRefine((value, ctx) => {
		const scoped =
			value.access === "read_only" || value.access === "read_write";
		if (
			!scoped &&
			(value.database_name !== undefined || value.schemas !== undefined)
		) {
			ctx.addIssue({
				code: "custom",
				message: ACCESS_FIELDS_NEED_SCOPED_ACCESS,
				path: [
					value.database_name === undefined
						? "schemas"
						: "database_name",
				],
			});
		}
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
				"Create a branch with a read-write endpoint by default. Pass no_compute to skip the endpoint. The call waits until operation-backed provisioning finishes, up to five minutes by default. Does not return a connection string; use branches.createAndConnect or postgres.connectionString for that.",
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
					{
						projectId: input.project_id,
						name: input.name,
						parent_id: input.parent_id,
						noCompute: true,
					},
					{ signal },
				);
			}
			return neon.branches.create(
				{
					projectId: input.project_id,
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
				{
					projectId: input.project_id,
					name: input.name,
					parentId: input.parent_id,
					compute: mapCompute(input.compute),
					...(input.pooled === undefined
						? {}
						: { pooled: input.pooled }),
				},
				{ signal },
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
		(neon, input, signal) =>
			neon.projects.createAndConnect(input, { signal }),
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
			neon.branches.getDefault(
				{ projectId: input.project_id },
				{ signal },
			),
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
				{
					projectId: input.project_id,
					branchId: input.branch_id,
					...(input.preserve_under_name === undefined
						? undefined
						: { preserveUnderName: input.preserve_under_name }),
				},
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
				{
					projectId: input.project_id,
					branchId: input.branch_id,
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

export const createRoleTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "postgres.roles.create",
			id: publishedId("postgres.roles.create"),
			title: "Create role",
			description:
				"Create a Postgres role on a branch and return it with its password. access defaults to admin: the role joins neon_superuser, so it can read and write every database, create databases and roles, and bypass row-level security, and it cannot be narrowed later. For a least-privilege credential pass access read_only or read_write, scoped to database_name and schemas. Scoped roles are created with SQL as the database owner and cover tables that owner owns, now and later.",
			inputSchema: createRoleInputSchema,
			annotations: writeAnnotations,
			requiresApproval: true,
			metadata: {
				method: "POST",
				path: "/projects/{project_id}/branches/{branch_id}/roles",
				stability: "stable",
				deprecated: false,
				tags: ["Branch"],
			},
		},
		(neon, input, signal) => {
			const role = {
				projectId: input.project_id,
				branchId: input.branch_id,
				name: input.name,
				...(input.no_login === undefined
					? {}
					: { no_login: input.no_login }),
			};
			if (input.access === "read_only" || input.access === "read_write") {
				return neon.postgres.roles.create(
					{
						...role,
						access: input.access,
						...(input.database_name === undefined
							? {}
							: { databaseName: input.database_name }),
						...(input.schemas === undefined
							? {}
							: { schemas: input.schemas }),
					},
					{ signal },
				);
			}
			return neon.postgres.roles.create(role, { signal });
		},
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
				{
					projectId: input.project_id,
					snapshotId: input.snapshot_id,
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
				{
					projectId: input.project_id,
					branchId: input.branch_id,
					schedule: input.schedule,
				},
				{ signal },
			),
	);
