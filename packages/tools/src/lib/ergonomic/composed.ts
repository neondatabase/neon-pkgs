import * as z from "zod";
import { pathInputDescriptions } from "../../descriptions.gen.js";
import * as zod from "../../generated/zod.gen.js";
import {
	COMPUTE_ID_DESCRIPTION,
	databaseNameField,
	resolveConnection,
	roleNameField,
} from "../custom/sql/connection.js";
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
	.describe("Pooled connection string; default true, false for a direct one.")
	.optional();

const branchCreateFields = zod.zBranchCreateRequest.shape.branch.unwrap().shape;

const parentIdField = branchCreateFields.parent_id.describe(
	"Parent branch id (br-...). Omit for the project's default branch.",
);
const projectCreateFields = zod.zCreateProjectBody.shape.project.shape;

const computeSettingsSchema = z
	.strictObject({
		min_cu: zod.zComputeUnit.optional(),
		max_cu: zod.zComputeUnit.optional(),
		suspend_timeout_seconds: zod.zSuspendTimeoutSeconds.optional(),
	})
	.describe(
		"Autoscaling limits and suspend timeout for the read-write endpoint.",
	)
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
		project_id: zod.zCreateProjectBranchPath.shape.project_id.describe(
			pathInputDescriptions.project_id,
		),
		name: branchCreateFields.name,
		parent_id: parentIdField,
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
	project_id: zod.zCreateProjectBranchPath.shape.project_id.describe(
		pathInputDescriptions.project_id,
	),
	name: branchCreateFields.name,
	parent_id: parentIdField,
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
	project_id: zod.zListProjectBranchesPath.shape.project_id.describe(
		pathInputDescriptions.project_id,
	),
});

export const resetFromParentInputSchema = z.strictObject({
	project_id: zod.zRestoreProjectBranchPath.shape.project_id.describe(
		pathInputDescriptions.project_id,
	),
	branch_id: zod.zRestoreProjectBranchPath.shape.branch_id.describe(
		pathInputDescriptions.branch_id,
	),
	preserve_under_name:
		zod.zBranchRestoreRequest.shape.preserve_under_name.describe(
			"Name under which to save the current branch before the reset. Required when the branch has children; those children move to the new branch.",
		),
});

const compareQuery = zod.zGetProjectBranchSchemaComparisonQuery.shape;

export const compareSchemaInputSchema = z.strictObject({
	project_id:
		zod.zGetProjectBranchSchemaComparisonPath.shape.project_id.describe(
			pathInputDescriptions.project_id,
		),
	branch_id:
		zod.zGetProjectBranchSchemaComparisonPath.shape.branch_id.describe(
			pathInputDescriptions.branch_id,
		),
	database_name: compareQuery.db_name,
	base_branch_id: compareQuery.base_branch_id.describe(
		"Branch id (br-...) to compare against, not its name. Omit for the parent branch.",
	),
	lsn: compareQuery.lsn,
	timestamp: compareQuery.timestamp,
	base_lsn: compareQuery.base_lsn,
	base_timestamp: compareQuery.base_timestamp,
});

export const lokiQueryRangeInputSchema = z.strictObject({
	project_id: zod.zQueryProjectBranchLogsPath.shape.project_id.describe(
		pathInputDescriptions.project_id,
	),
	branch_id: zod.zQueryProjectBranchLogsPath.shape.branch_id.describe(
		pathInputDescriptions.branch_id,
	),
	query: z
		.string()
		.min(1)
		.describe(
			'LogQL stream selector with optional line filters, e.g. {entity_type="function"} |= "error". The source label is entity_type. No parsers, formatting stages, or metric queries.',
		),
	since: z
		.string()
		.describe(
			"Lookback as a Go duration such as 30m or 24h, ending at end or now. Defaults to 1h. start takes precedence.",
		)
		.optional(),
	start: z
		.string()
		.describe("Window start as RFC 3339 or Unix nanoseconds.")
		.optional(),
	end: z
		.string()
		.describe(
			"Window end as RFC 3339 or Unix nanoseconds. Defaults to now.",
		)
		.optional(),
	limit: z
		.number()
		.int()
		.positive()
		.describe("Maximum log lines. The server enforces its own cap.")
		.optional(),
	direction: z
		.enum(["forward", "backward"])
		.describe("backward (default) is newest first.")
		.optional(),
});

export const lokiQueryRangeTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "logs.loki.queryRange",
			id: publishedId("logs.loki.queryRange"),
			title: "Query branch logs (Loki)",
			description:
				"Runs a LogQL range query on a branch's logs and returns Loki's response: data.result groups lines by stream label as [nanosecond timestamp, line]. {{logs.query}} has structured filters; {{logs.fields}} and {{logs.fieldValues}} list labels. No cursor: limit lines, or the silent 10,000 cap, may mean more exist; narrow the window.",
			inputSchema: lokiQueryRangeInputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			requiresApproval: false,
			metadata: {
				method: "GET",
				path: "/telemetry/v1/projects/{project_id}/branches/{branch_id}/loki/api/v1/query_range",
				stability: "beta",
				deprecated: false,
				tags: ["Branch"],
			},
		},
		(neon, input, signal) =>
			neon.logs.loki.queryRange(
				{
					projectId: input.project_id,
					branchId: input.branch_id,
					query: input.query,
					since: input.since,
					start: input.start,
					end: input.end,
					limit: input.limit,
					direction: input.direction,
				},
				{ signal },
			),
	);

export const connectionStringInputSchema = z.strictObject({
	project_id: zod.zGetConnectionUriPath.shape.project_id.describe(
		pathInputDescriptions.project_id,
	),
	branch_id: zod.zGetConnectionUriQuery.shape.branch_id.describe(
		`${pathInputDescriptions.branch_id} Omit it for the default branch.`,
	),
	endpoint_id: zod.zGetConnectionUriQuery.shape.endpoint_id.describe(
		COMPUTE_ID_DESCRIPTION,
	),
	database_name: databaseNameField,
	role_name: roleNameField,
	pooled: pooledField,
});

const roleCreateFields = zod.zCreateProjectBranchRoleBody.shape.role.shape;

const ACCESS_FIELDS_NEED_SCOPED_ACCESS =
	"database_name and schemas apply only to access read_only or read_write.";

export const createRoleInputSchema = z
	.strictObject({
		project_id: zod.zCreateProjectBranchRolePath.shape.project_id.describe(
			pathInputDescriptions.project_id,
		),
		branch_id: zod.zCreateProjectBranchRolePath.shape.branch_id.describe(
			pathInputDescriptions.branch_id,
		),
		name: roleCreateFields.name,
		no_login: roleCreateFields.no_login,
		access: z
			.enum(["admin", "read_only", "read_write"])
			.describe(
				"read_only grants SELECT; read_write adds INSERT, UPDATE, DELETE, and sequences, on top of what PUBLIC has. Default admin joins neon_superuser.",
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
	project_id: zod.zRestoreSnapshotPath.shape.project_id.describe(
		pathInputDescriptions.project_id,
	),
	snapshot_id: zod.zRestoreSnapshotPath.shape.snapshot_id,
	name: zod.zRestoreSnapshotBody.shape.name,
	target_branch_id: zod.zRestoreSnapshotBody.shape.target_branch_id,
	finalize: z
		.boolean()
		.describe(
			"Move computes onto the restored branch now. Default true for a new branch, false onto an existing one.",
		)
		.optional(),
});

const snapshotFrequency = z.enum(["daily", "weekly", "monthly"]);

export const setScheduleInputSchema = z.strictObject({
	project_id: zod.zSetSnapshotSchedulePath.shape.project_id.describe(
		pathInputDescriptions.project_id,
	),
	branch_id: zod.zSetSnapshotSchedulePath.shape.branch_id.describe(
		pathInputDescriptions.branch_id,
	),
	schedule: z
		.array(
			z.strictObject({
				...zod.zBackupScheduleItem.shape,
				frequency: snapshotFrequency,
			}),
		)
		.describe("Schedule entries defining the backup frequency."),
});

export const createBranchTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "branches.create",
			id: publishedId("branches.create"),
			title: "Create branch",
			description:
				"Creates a branch from its parent's current data, with a read-write compute unless no_compute, and waits until it is ready. Returns no connection string; use {{postgres.connectionString}}.",
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
				"Creates a branch with a read-write compute, waits until it is ready, and returns its connection string.",
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
				"Creates a project with a default branch and read-write compute and waits until it is ready. Returns no connection string; use {{postgres.connectionString}}.",
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
				"Creates a project, waits until its default branch is ready, and returns a connection string to it.",
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
				"Gets the project's default branch by its default flag, not its name.",
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
				"Resets a branch to its parent's current state, discarding the branch's own changes. NEVER run autonomously; always ask the user first. preserve_under_name first saves the current state as a new branch. To restore a snapshot, use {{snapshots.restore}}.",
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
				"Diffs one database's SQL schema on a branch against another branch, by default its parent. lsn, timestamp, base_lsn, and base_timestamp are only for point-in-time comparisons.",
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
				"Returns a Postgres connection string with a role password; the branch needs a compute. Omitted inputs resolve like the SQL tools: default branch, neondb or the first database, and its owner. Call it after {{projects.create}} or {{branches.create}}, which return none.",
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
		async (neon, input, signal, context) => {
			const { endpoint_id, ...target } = input;
			const connection = await resolveConnection(
				neon,
				endpoint_id === undefined
					? target
					: { ...target, compute_id: endpoint_id },
				context,
				signal,
			);
			return connection.uri;
		},
	);

export const createRoleTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "postgres.roles.create",
			id: publishedId("postgres.roles.create"),
			title: "Create role",
			description:
				"Creates a Postgres role on a branch and returns its password. The default access, admin, joins neon_superuser: every database, creating databases and roles, bypassing row-level security, and it cannot be narrowed later. For least privilege pass read_only or read_write with database_name and schemas, covering the tables the database owner owns, now and later.",
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
				"Restores a snapshot onto a new branch or onto target_branch_id and waits until it is ready. With finalize false, swap it in later with {{branches.finalizeRestore}}.",
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
			description: "Replaces a branch's automatic snapshot schedule.",
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
