import { describe, expect, test } from "vitest";
import * as z from "zod";
import {
	createNeonTools,
	isCredential,
	type NeonToolId,
	type NeonTools,
	outputDataSchema,
	toolIds,
	toStructuredContent,
	withoutCredentials,
	withoutOutputFields,
} from "./index.js";
import { mcpResultSchema } from "./lib/mcp-register.js";
import { toMcpOutputSchema } from "./mcp.js";

const catalog = createNeonTools({ apiKey: "test-key", tools: toolIds });
const tools = Object.values(catalog);

/** Field names mcp-server-neon strips from results before returning them. */
const strippedFields = [
	"connection_uris",
	"connectionString",
	"secret_server_key",
	"client_secret",
	"password",
];

/** Every object field in `schema`, with its name, at any depth. */
const objectFields = (
	schema: z.ZodType,
	seen = new Set<z.ZodType>(),
): Array<[string, z.ZodType]> => {
	if (seen.has(schema)) return [];
	seen.add(schema);
	const children: z.ZodType[] = [];
	const fields: Array<[string, z.ZodType]> = [];
	if (schema instanceof z.ZodObject) {
		for (const [name, field] of Object.entries(
			schema.shape as Record<string, z.ZodType>,
		)) {
			fields.push([name, field]);
			children.push(field);
		}
	} else if (
		schema instanceof z.ZodOptional ||
		schema instanceof z.ZodNullable ||
		schema instanceof z.ZodReadonly
	) {
		children.push(schema.unwrap() as z.ZodType);
	} else if (schema instanceof z.ZodArray) {
		children.push(schema.element as z.ZodType);
	} else if (schema instanceof z.ZodUnion) {
		children.push(...(schema.options as z.ZodType[]));
	} else if (schema instanceof z.ZodRecord) {
		children.push(schema.valueType as z.ZodType);
	}
	return [
		...fields,
		...children.flatMap((child) => objectFields(child, seen)),
	];
};

describe("tool output schemas", () => {
	test.each(
		tools.map((tool) => [tool.id, tool] as const),
	)("%s has an object outputSchema that converts to JSON Schema", (_, tool) => {
		expect(tool.outputSchema).toBeInstanceOf(z.ZodObject);
		expect(
			z.toJSONSchema(tool.outputSchema, { io: "output" }),
		).toMatchObject({ type: "object" });
		expect(() =>
			z.toJSONSchema(outputDataSchema(tool.outputSchema), {
				io: "output",
			}),
		).not.toThrow();
		expect(
			toMcpOutputSchema(mcpResultSchema(tool))[
				"~standard"
			].jsonSchema.output(),
		).toMatchObject({
			type: "object",
			properties: { data: expect.any(Object) },
		});
	});

	test("every field a host strips by name or marks as a credential is optional", () => {
		const required = tools.flatMap((tool) =>
			objectFields(tool.outputSchema)
				.filter(
					([name, field]) =>
						(strippedFields.includes(name) ||
							isCredential(field)) &&
						!field.safeParse(undefined).success,
				)
				.map(([name]) => `${tool.id}.${name}`),
		);
		expect(required).toEqual([]);
	});

	test("withoutCredentials and withoutOutputFields remove what they name", () => {
		for (const tool of tools) {
			expect(
				objectFields(withoutCredentials(tool.outputSchema)).filter(
					([, field]) => isCredential(field),
				),
				tool.id,
			).toEqual([]);
			expect(
				objectFields(
					withoutOutputFields(tool.outputSchema, strippedFields),
				)
					.map(([name]) => name)
					.filter((name) => strippedFields.includes(name)),
				tool.id,
			).toEqual([]);
		}
	});

	test("credential fields are marked on the tools that return secrets", () => {
		const marked = (id: NeonToolId) =>
			[
				...new Set(
					objectFields(catalog[id].outputSchema)
						.filter(([, field]) => isCredential(field))
						.map(([name]) => name),
				),
			].sort();
		expect({
			"projects.createAndConnect": marked("projects.createAndConnect"),
			"postgres.roles.create": marked("postgres.roles.create"),
			"apiKeys.create": marked("apiKeys.create"),
			"postgres.connectionString": marked("postgres.connectionString"),
			"auth.getConfig": marked("auth.getConfig"),
			"projects.get": marked("projects.get"),
		}).toEqual({
			"projects.createAndConnect": ["connectionString"],
			"postgres.roles.create": ["password"],
			"apiKeys.create": ["key"],
			"postgres.connectionString": ["value"],
			"auth.getConfig": ["client_secret", "password"],
			"projects.get": [],
		});
	});
});

type ToolData<Id extends NeonToolId> = Awaited<
	ReturnType<NeonTools<[Id]>[Id]["execute"]>
>["data"];

const branch = {
	id: "br-main",
	project_id: "proj",
	name: "main",
	current_state: "ready",
	state_changed_at: "2026-01-01T00:00:00Z",
	creation_source: "console",
	default: true,
	protected: false,
	cpu_used_sec: 0,
	compute_time_seconds: 0,
	active_time_seconds: 0,
	written_data_bytes: 0,
	data_transfer_bytes: 0,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

const project = {
	id: "proj",
	platform_id: "aws",
	region_id: "aws-us-east-2",
	name: "app",
	provisioner: "k8s-neonvm",
	pg_version: 17,
	proxy_host: "us-east-2.aws.neon.tech",
	branch_logical_size_limit: 0,
	branch_logical_size_limit_bytes: 0,
	store_passwords: true,
	creation_source: "console",
	history_retention_seconds: 86_400,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
	owner_id: "owner",
	data_storage_bytes_hour: 0,
	data_transfer_bytes: 0,
	written_data_bytes: 0,
	compute_time_seconds: 0,
	active_time_seconds: 0,
	cpu_used_sec: 0,
	consumption_period_start: "2026-01-01T00:00:00Z",
	consumption_period_end: "2026-02-01T00:00:00Z",
};

const tableDescription = {
	columns: [
		{
			name: "id",
			type: "integer",
			nullable: false,
			default: null,
			description: null,
		},
	],
	indexes: [
		{
			name: "items_pkey",
			definition: "CREATE UNIQUE INDEX items_pkey ON public.items (id)",
			size: "16 kB",
		},
	],
	constraints: [
		{
			name: "items_pkey",
			type: "PRIMARY KEY",
			definition: "PRIMARY KEY (id)",
		},
	],
	tableSize: "8192 bytes",
	indexSize: "16 kB",
	totalSize: "24 kB",
};

const buffers = { hit: 1, read: 0, written: 0, dirtied: 0 };
const statistic = { hit: 1, read: "0", written: 0, dirtied: 0 };

/**
 * One result per hand-written tool, typed as that tool's `data` so a fixture
 * cannot drift from what `execute` returns.
 */
const fixtures: { [Id in FixtureId]: ToolData<Id> } = {
	"auth.getConfig": {
		project_id: "proj",
		branch_id: "br-main",
		branch_name: "main",
		base_url: "https://ep-1.neonauth.us-east-2.aws.neon.tech/neondb/auth",
		jwks_url:
			"https://ep-1.neonauth.us-east-2.aws.neon.tech/neondb/auth/jwks",
		db_name: "neondb",
		integration: {
			auth_provider: "better_auth",
			auth_provider_project_id: "auth-proj",
			branch_id: "br-main",
			db_name: "neondb",
			created_at: "2026-01-01T00:00:00Z",
			owned_by: "neon",
			jwks_url:
				"https://ep-1.neonauth.us-east-2.aws.neon.tech/neondb/auth/jwks",
			base_url: null,
		},
		trusted_origins: ["https://app.example.com"],
		allow_localhost: true,
		auth_methods: {
			email_password: {
				enabled: true,
				allow_sign_up: true,
				verify_email_on_sign_up: false,
				verify_email_on_sign_in: false,
				email_verification_method: "otp",
				require_email_verification: false,
				auto_sign_in_after_verification: true,
				revoke_sessions_on_password_reset: true,
			},
		},
		oauth_providers: [
			{
				id: "google",
				type: "standard",
				client_id: "client",
				client_secret: "[REDACTED]",
			},
		],
		email_provider: {
			type: "standard",
			host: "smtp.example.com",
			port: 587,
			username: "mailer",
			password: "[REDACTED]",
			sender_email: "auth@example.com",
			sender_name: "App",
		},
		plugins: {
			organization: null,
			magic_link: {
				enabled: false,
				expires_in: 300,
				disable_sign_up: false,
			},
			phone_number: { enabled: false, otp_expires_in: null },
		},
		webhook: null,
		logs_export: { enabled: false },
		_errors: { webhook: "not configured" },
	},
	"resources.search": {
		results: [
			{
				id: "project:proj",
				title: "app",
				url: "https://console.neon.tech/app/projects/proj",
			},
		],
	},
	"resources.fetch": {
		id: "project:proj",
		title: "app",
		text: "Project app",
		url: "https://console.neon.tech/app/projects/proj",
		metadata: { project, branches: [branch] },
	},
	"sql.run": {
		rows: [{ n: 1 }],
		totalRowCount: 3,
		truncated: true,
		note: "Showing the first 1 of 3 rows.",
	},
	"sql.runTransaction": [{ rows: [], totalRowCount: 0, truncated: false }],
	"sql.explain": [{ "QUERY PLAN": "Seq Scan on items" }],
	"schema.listTables": [
		{
			table_schema: "public",
			table_name: "items",
			table_type: "BASE TABLE",
		},
	],
	"schema.describeTable": {
		raw: tableDescription,
		formatted: "Table public.items",
	},
	"branches.describe": {
		branch,
		console_url:
			"https://console.neon.tech/app/projects/proj/branches/br-main",
		text: "Branch main",
		database_structure: null,
		database_structure_error: "permission denied",
	},
	"queries.listSlow": {
		slow_queries: [
			{
				query: "SELECT 1",
				calls: "10",
				total_exec_time_ms: 12.5,
				mean_exec_time_ms: 1.25,
				rows: 10,
				shared_blocks: statistic,
				temp_blocks: { read: 0, written: 0 },
				wal: { records: 0, full_page_images: 0, bytes: "0" },
			},
		],
		total_queries_found: 1,
	},
	"database.inspect": {
		check: "table-sizes",
		describe: "Table sizes",
		projectId: "proj",
		branchId: "br-main",
		databaseName: "neondb",
		databases: ["neondb"],
		fields: ["table", "size"],
		totalRowCount: 1,
		rows: [{ table: "items", size: "8192 bytes" }],
		truncated: false,
	},
	"migrations.prepare": {
		complete: {
			migration_id: "00000000-0000-4000-8000-000000000001",
			migration_sql: "ALTER TABLE items ADD COLUMN name text",
			database_name: "neondb",
			project_id: "proj",
			temporary_branch_id: "br-tmp",
			parent_branch_id: "br-main",
		},
		temporary_branch: {
			id: "br-tmp",
			name: "mcp-migration-mig",
			parent_id: "br-main",
		},
		migration_result: [[]],
	},
	"migrations.complete": {
		applied: true,
		deletedBranchId: "br-tmp",
		migrationResult: [[]],
	},
	"queryTuning.prepare": {
		complete: {
			tuning_id: "00000000-0000-4000-8000-000000000002",
			database_name: "neondb",
			project_id: "proj",
			temporary_branch_id: "br-tmp",
		},
		execution_plan: [{ "QUERY PLAN": [] }],
		table_schemas: [
			{
				tableName: "items",
				schema: tableDescription,
				formatted: "Table items",
			},
		],
		sql: "SELECT * FROM items",
		baseline_metrics: {
			executionTime: 1,
			planningTime: 0.1,
			totalCost: 10,
			actualRows: 1,
			bufferUsage: { shared: buffers, local: buffers },
		},
	},
	"queryTuning.complete": {
		message: "Discarded the temporary branch.",
		deletedBranches: ["br-tmp"],
	},
	"docs.search": {
		hits: [
			{
				title: "Branching",
				url: "https://neon.com/docs/introduction/branching",
				slug: "docs/introduction/branching",
				category: "docs",
				breadcrumb: ["Introduction"],
				heading: "Branching",
				excerpt: "Branch your database.",
			},
		],
	},
	"docs.get": {
		url: "https://neon.com/docs/introduction/branching.md",
		markdown: "# Branching",
	},
	"feedback.send": { message: "Feedback received. Thank you!" },
	"user.organizations": [
		{
			id: "org",
			name: "Org",
			handle: "org",
			plan: "launch",
			created_at: "2026-01-01T00:00:00Z",
			managed_by: "console",
			updated_at: "2026-01-01T00:00:00Z",
		},
	],
	"logs.loki.queryRange": {
		status: "success",
		data: {
			resultType: "streams",
			result: [
				{ stream: { service: "postgres" }, values: [["1", "line"]] },
			],
		},
	},
	"postgres.connectionString": "postgresql://user:secret@host/neondb",
	"snapshots.setSchedule": null,
};

type FixtureId =
	| typeof import("./index.js")["customToolIds"][number]
	| "user.organizations"
	| "logs.loki.queryRange"
	| "postgres.connectionString"
	| "snapshots.setSchedule";

describe("hand-written tool output schemas", () => {
	const byId = createNeonTools({
		apiKey: "test-key",
		tools: Object.keys(fixtures) as FixtureId[],
	});

	test.each(
		Object.entries(fixtures),
	)("%s accepts a fixture of its result", (id, data) => {
		const tool = byId[id as FixtureId];
		expect(outputDataSchema(tool.outputSchema).parse(data)).toEqual(data);
		expect(tool.outputSchema.parse(toStructuredContent(data))).toEqual(
			toStructuredContent(data),
		);
		expect(
			mcpResultSchema(tool).parse({
				data: JSON.parse(JSON.stringify(data)),
			}),
		).toEqual({ data });
	});

	test("a result missing a required field is rejected", () => {
		const { totalRowCount: _, ...data } = fixtures["sql.run"];
		expect(
			outputDataSchema(byId["sql.run"].outputSchema).safeParse(data)
				.success,
		).toBe(false);
	});
});
