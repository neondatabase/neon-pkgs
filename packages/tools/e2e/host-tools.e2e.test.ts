import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import {
	configuredBaseUrl,
	createProject,
	deleteProject,
	requireApiKey,
	uniqueProjectName,
} from "@neon/e2e-harness";
import {
	createNeonClient,
	NeonClientError,
	NeonNotFoundError,
	NeonWaitTimeoutError,
} from "@neon/sdk";
import { NeonDbError } from "@neondatabase/serverless";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNeonTools, customToolIds, publishedId } from "../src/index.js";
import { registerNeonTools } from "../src/mcp.js";

const sqlToolIds = [
	"postgres.connectionString",
	"sql.run",
	"sql.runTransaction",
	"sql.explain",
	"schema.listTables",
	"schema.describeTable",
	"branches.describe",
	"queries.listSlow",
	"database.inspect",
	"migrations.prepare",
	"migrations.complete",
	"queryTuning.prepare",
	"queryTuning.complete",
] as const;

const READ_ONLY_ROLE = "e2e_reader";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The plan document from the single row `EXPLAIN (FORMAT JSON)` returns. */
const planDocument = (rows: readonly unknown[]): Record<string, unknown> => {
	const row = rows[0];
	const documents = isRecord(row) ? row["QUERY PLAN"] : undefined;
	const document = Array.isArray(documents) ? documents[0] : undefined;
	if (!isRecord(document)) throw new Error("No EXPLAIN plan document");
	return document;
};

/**
 * The SQL tools against one project. Tests run in order and build on each
 * other: the first creates `items`, later ones migrate and index it.
 */
describe.sequential("e2e — @neon/tools SQL tools", () => {
	const neon = createNeonClient({
		apiKey: requireApiKey(),
		baseUrl: configuredBaseUrl(),
		throwOnError: true,
	});
	const tools = createNeonTools({
		apiKey: requireApiKey(),
		baseUrl: configuredBaseUrl(),
		tools: sqlToolIds,
	});
	let projectId: string;
	let mainBranchId: string;

	const run = (sql: string, extra: { max_rows?: number } = {}) =>
		tools["sql.run"].execute({ project_id: projectId, sql, ...extra });

	const branchExists = async (branchId: string) => {
		try {
			await neon.branches.get({ projectId, branchId });
			return true;
		} catch (error) {
			if (error instanceof NeonNotFoundError) return false;
			throw error;
		}
	};

	const branchIds = async () =>
		(await neon.branches.list({ projectId }).all()).map(
			(branch) => branch.id,
		);

	/** Polls until the project has no branch outside `expected`; a delete takes a moment to show. */
	const expectOnlyBranches = async (expected: readonly string[]) => {
		const deadline = Date.now() + 60_000;
		let extra: string[] = [];
		while (Date.now() < deadline) {
			extra = (await branchIds()).filter((id) => !expected.includes(id));
			if (extra.length === 0) return;
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
		throw new Error(`Temporary branches left behind: ${extra.join(", ")}`);
	};

	beforeAll(async () => {
		projectId = await createProject({
			name: uniqueProjectName("tools-sql"),
		});
		mainBranchId = (await neon.branches.getDefault({ projectId })).id;
		await neon.postgres.roles.create({
			projectId,
			branchId: mainBranchId,
			name: READ_ONLY_ROLE,
			access: "read_only",
			databaseName: "neondb",
			schemas: ["public"],
		});
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
	});

	it("sql.run creates a table, inserts, and selects", async () => {
		await run(
			"CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL)",
		);
		const inserted = await run(
			"INSERT INTO items (name) VALUES ('a'), ('b'), ('c') RETURNING id",
		);
		expect(inserted.data.totalRowCount).toBe(3);
		const { data } = await run("SELECT name FROM items ORDER BY id");
		expect(data).toEqual({
			rows: [{ name: "a" }, { name: "b" }, { name: "c" }],
			totalRowCount: 3,
			truncated: false,
		});
	});

	it("sql.run caps rows at max_rows and says so", async () => {
		const { data } = await run("SELECT n FROM generate_series(1, 5) AS n", {
			max_rows: 2,
		});
		expect(data).toEqual({
			rows: [{ n: 1 }, { n: 2 }],
			totalRowCount: 5,
			truncated: true,
			note: "Showing the first 2 of 5 rows. To see more, raise `max_rows` or narrow the query with WHERE or LIMIT. The SQL already ran, so if it changed data, running it again repeats the change.",
		});
	});

	it("sql.run returns a bytea column the way JSON.stringify serializes a Buffer", async () => {
		const { data } = await run("SELECT '\\xdeadbeef'::bytea AS payload");
		expect(data.rows).toEqual([
			{ payload: { type: "Buffer", data: [222, 173, 190, 239] } },
		]);
	});

	it("sql.run rejects a syntax error with the Postgres NeonDbError", async () => {
		const failure = run("SELEC 1");
		await expect(failure).rejects.toBeInstanceOf(NeonDbError);
		await expect(failure).rejects.toMatchObject({ code: "42601" });
	});

	it("readOnly: sql.run reads but Postgres rejects writes", async () => {
		const context = { readOnly: true };
		const { data } = await tools["sql.run"].execute(
			{
				project_id: projectId,
				sql: "SELECT count(*)::int AS n FROM items",
			},
			context,
		);
		expect(data.rows).toEqual([{ n: 3 }]);
		const write = tools["sql.run"].execute(
			{
				project_id: projectId,
				sql: "INSERT INTO items (name) VALUES ('x')",
			},
			context,
		);
		await expect(write).rejects.toBeInstanceOf(NeonDbError);
		await expect(write).rejects.toMatchObject({ code: "25006" });
	});

	it("readOnly: transaction and migration tools refuse to run", async () => {
		const context = { readOnly: true };
		const branchesBefore = await neon.branches.list({ projectId }).all();
		const transaction = tools["sql.runTransaction"].execute(
			{ project_id: projectId, sql_statements: ["SELECT 1"] },
			context,
		);
		await expect(transaction).rejects.toBeInstanceOf(NeonClientError);
		await expect(transaction).rejects.toThrow(
			"This tool is unavailable in read-only mode because it runs caller SQL that can leave a read-only transaction.",
		);
		const migration = tools["migrations.prepare"].execute(
			{ project_id: projectId, migration_sql: "SELECT 1" },
			context,
		);
		await expect(migration).rejects.toBeInstanceOf(NeonClientError);
		await expect(migration).rejects.toThrow(
			"This tool is unavailable in read-only mode because it runs caller SQL that can leave a read-only transaction.",
		);
		const branchesAfter = await neon.branches.list({ projectId }).all();
		expect(branchesAfter).toHaveLength(branchesBefore.length);
	});

	it("postgresRole: connects as the pinned role and rejects another role_name", async () => {
		const context = { postgresRole: READ_ONLY_ROLE };
		const { data } = await tools["sql.run"].execute(
			{ project_id: projectId, sql: "SELECT current_user AS role" },
			context,
		);
		expect(data.rows).toEqual([{ role: READ_ONLY_ROLE }]);
		const mismatch = tools["sql.run"].execute(
			{
				project_id: projectId,
				sql: "SELECT 1",
				role_name: "neondb_owner",
			},
			context,
		);
		await expect(mismatch).rejects.toBeInstanceOf(NeonClientError);
		await expect(mismatch).rejects.toThrow(
			`This connection is pinned to Postgres role "${READ_ONLY_ROLE}"; role_name "neondb_owner" is not allowed.`,
		);
	});

	it("postgres.connectionString resolves the database and role like the SQL tools", async () => {
		await neon.postgres.databases.create(
			{
				projectId,
				branchId: mainBranchId,
				name: "analytics",
				owner_name: "neondb_owner",
			},
			{ waitForReadiness: true },
		);
		// A second database would change what later tests inspect, so it is dropped here.
		try {
			const connect = (
				input: {
					database_name?: string;
					role_name?: string;
					pooled?: boolean;
				},
				context = {},
			) =>
				tools["postgres.connectionString"].execute(
					{ project_id: projectId, ...input },
					context,
				);

			// Two databases and two roles: @neon/sdk alone would refuse to pick.
			const omitted = new URL((await connect({})).data);
			expect(omitted.pathname).toBe("/neondb");
			expect(omitted.username).toBe("neondb_owner");
			expect(omitted.hostname).toContain("-pooler");

			const analytics = new URL(
				(await connect({ database_name: "analytics", pooled: false }))
					.data,
			);
			expect(analytics.pathname).toBe("/analytics");
			expect(analytics.username).toBe("neondb_owner");
			expect(analytics.hostname).not.toContain("-pooler");

			const pinned = new URL(
				(await connect({}, { postgresRole: READ_ONLY_ROLE })).data,
			);
			expect(pinned.username).toBe(READ_ONLY_ROLE);
			expect(pinned.pathname).toBe("/neondb");

			const mismatch = connect(
				{ role_name: "neondb_owner" },
				{ postgresRole: READ_ONLY_ROLE },
			);
			await expect(mismatch).rejects.toBeInstanceOf(NeonClientError);
			await expect(mismatch).rejects.toThrow(
				`This connection is pinned to Postgres role "${READ_ONLY_ROLE}"; role_name "neondb_owner" is not allowed.`,
			);
		} finally {
			await neon.postgres.databases.delete(
				{
					projectId,
					branchId: mainBranchId,
					databaseName: "analytics",
				},
				{ waitForReadiness: true },
			);
		}
	});

	it("sql.runTransaction returns rows per statement", async () => {
		const { data } = await tools["sql.runTransaction"].execute({
			project_id: projectId,
			sql_statements: [
				"INSERT INTO items (name) VALUES ('d')",
				"SELECT count(*)::int AS n FROM items",
			],
		});
		expect(data).toEqual([
			{ rows: [], totalRowCount: 0, truncated: false },
			{ rows: [{ n: 4 }], totalRowCount: 1, truncated: false },
		]);
	});

	it("sql.explain returns the JSON plan, with timings only under analyze", async () => {
		const sql = "SELECT * FROM items WHERE name = 'b'";
		const plain = await tools["sql.explain"].execute({
			project_id: projectId,
			sql,
		});
		const plainDocument = planDocument(plain.data);
		expect(plainDocument).toMatchObject({
			Plan: { "Relation Name": "items" },
		});
		expect(plainDocument).not.toHaveProperty("Execution Time");
		const analyzed = await tools["sql.explain"].execute({
			project_id: projectId,
			sql,
			analyze: true,
		});
		expect(planDocument(analyzed.data)).toHaveProperty("Execution Time");
	});

	it("schema.listTables lists public.items", async () => {
		const { data } = await tools["schema.listTables"].execute({
			project_id: projectId,
		});
		expect(data).toContainEqual({
			table_schema: "public",
			table_name: "items",
			table_type: "BASE TABLE",
		});
	});

	it("schema.describeTable returns columns and a formatted description", async () => {
		const { data } = await tools["schema.describeTable"].execute({
			project_id: projectId,
			table_name: "public.items",
		});
		expect(data.raw.columns.map((column) => column.name)).toEqual([
			"id",
			"name",
		]);
		expect(data.raw.constraints).toContainEqual(
			expect.objectContaining({ type: "PRIMARY KEY" }),
		);
		expect(data.formatted).toContain("name text NOT NULL");
		const missing = tools["schema.describeTable"].execute({
			project_id: projectId,
			table_name: "does_not_exist",
		});
		await expect(missing).rejects.toBeInstanceOf(NeonClientError);
		await expect(missing).rejects.toThrow(
			"Table not found: does_not_exist",
		);
	});

	it("schema.describeTable accepts the mixed case names schema.listTables returns", async () => {
		await run(`CREATE TABLE "User" (id int PRIMARY KEY)`);
		await run(`CREATE SCHEMA "Auth"`);
		await run(`CREATE TABLE "Auth"."User" (auth_id int)`);
		const { data: tables } = await tools["schema.listTables"].execute({
			project_id: projectId,
		});
		expect(tables).toContainEqual({
			table_schema: "public",
			table_name: "User",
			table_type: "BASE TABLE",
		});
		const columnsOf = async (table_name: string) => {
			const { data } = await tools["schema.describeTable"].execute({
				project_id: projectId,
				table_name,
			});
			return data.raw.columns.map((column) => column.name);
		};
		expect(await columnsOf("User")).toEqual(["id"]);
		expect(await columnsOf("public.User")).toEqual(["id"]);
		expect(await columnsOf('"User"')).toEqual(["id"]);
		expect(await columnsOf("Auth.User")).toEqual(["auth_id"]);
		expect(await columnsOf('"Auth"."User"')).toEqual(["auth_id"]);
		await run(`DROP SCHEMA "Auth" CASCADE`);
		await run(`DROP TABLE "User"`);
	});

	it("branches.describe returns branch details and the database tree", async () => {
		const { data } = await tools["branches.describe"].execute({
			project_id: projectId,
			branch_id: mainBranchId,
		});
		expect(data.branch.id).toBe(mainBranchId);
		expect(data.text).toContain("Branch Details:");
		expect(data.database_structure?.[0]).toEqual([]);
		expect(data.database_structure?.[1]).toContainEqual({
			tree_structure: ":file_folder: neondb (DATABASE)",
		});
		expect(JSON.stringify(data.database_structure)).toContain(
			"items (TABLE)",
		);
		expect(data).not.toHaveProperty("database_structure_error");
	});

	it("branches.describe only reads: it works read-only and as a role without CREATE, and leaves show_db_tree alone", async () => {
		await run(
			"CREATE FUNCTION public.show_db_tree() RETURNS text LANGUAGE sql AS $$ SELECT 'mine' $$",
		);
		for (const context of [
			{ readOnly: true },
			{ postgresRole: READ_ONLY_ROLE },
		]) {
			const { data } = await tools["branches.describe"].execute(
				{ project_id: projectId, branch_id: mainBranchId },
				context,
			);
			expect(data).not.toHaveProperty("database_structure_error");
			expect(JSON.stringify(data.database_structure)).toContain(
				"items (TABLE)",
			);
		}
		const { data } = await run("SELECT public.show_db_tree() AS value");
		expect(data.rows).toEqual([{ value: "mine" }]);
		await run("DROP FUNCTION public.show_db_tree()");
	});

	it("branches.describe reports why the tree is missing when it cannot connect", async () => {
		const { data } = await tools["branches.describe"].execute(
			{ project_id: projectId, branch_id: mainBranchId },
			{ postgresRole: "no_such_role" },
		);
		expect(data.branch.id).toBe(mainBranchId);
		expect(data.database_structure).toBeNull();
		expect(data.database_structure_error).toContain(
			'Database structure unavailable as Postgres role "no_such_role"',
		);
	});

	it("queries.listSlow needs pg_stat_statements, then lists statements", async () => {
		const { data: extension } = await run(
			"SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_stat_statements'",
		);
		if (extension.rows[0]?.n === 0) {
			const missing = tools["queries.listSlow"].execute({
				project_id: projectId,
			});
			await expect(missing).rejects.toBeInstanceOf(NeonClientError);
			await expect(missing).rejects.toThrow(
				"pg_stat_statements extension is not installed on the database.",
			);
			await run("CREATE EXTENSION pg_stat_statements");
		}
		await run("SELECT count(*) FROM items");
		const { data } = await tools["queries.listSlow"].execute({
			project_id: projectId,
			limit: 5,
		});
		expect(data.total_queries_found).toBe(data.slow_queries.length);
		expect(data.slow_queries.length).toBeGreaterThan(0);
		expect(data.slow_queries.length).toBeLessThanOrEqual(5);
		expect(data.slow_queries[0]).toEqual(
			expect.objectContaining({
				query: expect.any(String),
				shared_blocks: expect.any(Object),
				wal: expect.any(Object),
			}),
		);
	});

	it("database.inspect runs table-sizes across every database", async () => {
		const { data } = await tools["database.inspect"].execute({
			project_id: projectId,
			check: "table-sizes",
		});
		expect(data).toMatchObject({
			check: "table-sizes",
			projectId,
			branchId: mainBranchId,
			databases: ["neondb"],
			fields: ["database", "schema", "name", "size"],
			truncated: false,
		});
		expect(data.rows).toContainEqual(
			expect.objectContaining({
				database: "neondb",
				schema: "public",
				name: "items",
			}),
		);
	});

	it("database.inspect keeps the SDK error class when it adds the database to the message", async () => {
		const failure = tools["database.inspect"].execute(
			{ project_id: projectId, check: "table-sizes" },
			{ postgresRole: "no_such_role" },
		);
		await expect(failure).rejects.toBeInstanceOf(NeonNotFoundError);
		await expect(failure).rejects.toThrow("(database neondb)");
		await expect(failure).rejects.toMatchObject({ status: 404 });
	});

	it("migrations.prepare then complete with apply_changes applies to the parent and deletes the temporary branch", async () => {
		const prepared = await tools["migrations.prepare"].execute({
			project_id: projectId,
			migration_sql: "ALTER TABLE items ADD COLUMN note text;",
		});
		const { complete } = prepared.data;
		expect(complete).toEqual({
			migration_id: expect.any(String),
			migration_sql: "ALTER TABLE items ADD COLUMN note text;",
			database_name: "neondb",
			project_id: projectId,
			temporary_branch_id: expect.any(String),
			parent_branch_id: mainBranchId,
		});
		expect(prepared.data.temporary_branch).toEqual({
			id: complete.temporary_branch_id,
			name: expect.stringMatching(/^mcp-migration-/),
			parent_id: mainBranchId,
		});
		const temporaryBranch = await neon.branches.get({
			projectId,
			branchId: complete.temporary_branch_id,
		});
		expect(temporaryBranch.name).toBe(prepared.data.temporary_branch.name);
		expect(prepared.data.migration_result).toEqual([[]]);
		const before = await tools["schema.describeTable"].execute({
			project_id: projectId,
			table_name: "items",
		});
		expect(
			before.data.raw.columns.map((column) => column.name),
		).not.toContain("note");

		const { data: completed } = await tools["migrations.complete"].execute({
			...prepared.data.complete,
			apply_changes: true,
		});
		expect(completed).toMatchObject({
			applied: true,
			deletedBranchId: complete.temporary_branch_id,
		});
		expect(completed).not.toHaveProperty("cleanupError");
		const after = await tools["schema.describeTable"].execute({
			project_id: projectId,
			table_name: "items",
		});
		expect(after.data.raw.columns.map((column) => column.name)).toContain(
			"note",
		);
		expect(await branchExists(complete.temporary_branch_id)).toBe(false);
	});

	it("migrations.complete with apply_changes false discards and deletes the temporary branch", async () => {
		const { data: prepared } = await tools["migrations.prepare"].execute({
			project_id: projectId,
			migration_sql:
				"CREATE TABLE discarded (id int); SELECT 42 AS answer",
		});
		expect(prepared.migration_result).toEqual([[], [{ answer: 42 }]]);
		const { data: completed } = await tools["migrations.complete"].execute({
			...prepared.complete,
			apply_changes: false,
		});
		expect(completed).toEqual({
			applied: false,
			deletedBranchId: prepared.complete.temporary_branch_id,
		});
		const { data: tables } = await tools["schema.listTables"].execute({
			project_id: projectId,
		});
		expect(tables.map((table) => table.table_name)).not.toContain(
			"discarded",
		);
		expect(await branchExists(prepared.complete.temporary_branch_id)).toBe(
			false,
		);
	});

	it("queryTuning.prepare then complete applies the index to the parent and deletes the temporary branch", async () => {
		const { data: prepared } = await tools["queryTuning.prepare"].execute({
			project_id: projectId,
			database_name: "neondb",
			sql: "SELECT count(*) FROM items WHERE name = 'b'",
		});
		expect(prepared.table_schemas.map((table) => table.tableName)).toEqual([
			"public.items",
		]);
		const root = planDocument(prepared.execution_plan).Plan;
		if (!isRecord(root)) throw new Error("No root plan node");
		expect(root["Node Type"]).toBe("Aggregate");
		expect(prepared.baseline_metrics).toMatchObject({
			executionTime: expect.any(Number),
			actualRows: 1,
			totalCost: root["Total Cost"],
			bufferUsage: {
				shared: expect.objectContaining({
					hit: root["Shared Hit Blocks"],
				}),
			},
		});
		expect(prepared.baseline_metrics.executionTime).toBeGreaterThan(0);
		expect(prepared.complete).toEqual({
			tuning_id: expect.any(String),
			database_name: "neondb",
			project_id: projectId,
			temporary_branch_id: expect.any(String),
		});
		const temporaryBranchId = prepared.complete.temporary_branch_id;
		expect(await branchExists(temporaryBranchId)).toBe(true);

		const { data: completed } = await tools["queryTuning.complete"].execute(
			{
				...prepared.complete,
				suggested_sql_statements: [
					"CREATE INDEX items_name_idx ON items (name)",
				],
				apply_changes: true,
			},
		);
		expect(completed).toMatchObject({
			appliedChanges: ["CREATE INDEX items_name_idx ON items (name)"],
			deletedBranches: [temporaryBranchId],
		});
		const { data: described } = await tools["schema.describeTable"].execute(
			{
				project_id: projectId,
				table_name: "items",
			},
		);
		expect(described.raw.indexes.map((index) => index.name)).toContain(
			"items_name_idx",
		);
		expect(await branchExists(temporaryBranchId)).toBe(false);
	});

	it("a readiness timeout in the prepare tools deletes the temporary branch", async () => {
		const impatient = createNeonTools({
			apiKey: requireApiKey(),
			baseUrl: configuredBaseUrl(),
			wait: { timeoutMs: 1 },
			tools: ["migrations.prepare", "queryTuning.prepare"],
		});
		const before = await branchIds();
		await expect(
			impatient["migrations.prepare"].execute({
				project_id: projectId,
				migration_sql: "CREATE TABLE never_created (id int);",
			}),
		).rejects.toBeInstanceOf(NeonWaitTimeoutError);
		await expect(
			impatient["queryTuning.prepare"].execute({
				project_id: projectId,
				database_name: "neondb",
				sql: "SELECT count(*) FROM items",
			}),
		).rejects.toBeInstanceOf(NeonWaitTimeoutError);
		await expectOnlyBranches(before);
		const branches = await neon.branches.list({ projectId }).all();
		expect(
			branches.filter((branch) =>
				branch.name.startsWith("mcp-migration-"),
			),
		).toEqual([]);
	});

	it("every new tool is listed over MCP and sql.run is callable", async () => {
		const allTools = createNeonTools({
			apiKey: requireApiKey(),
			baseUrl: configuredBaseUrl(),
			tools: customToolIds,
		});
		const server = new McpServer({ name: "e2e", version: "1.0.0" });
		registerNeonTools(server, allTools);
		const client = new Client({ name: "e2e-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		try {
			const listed = await client.listTools();
			expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
				customToolIds.map(publishedId).sort(),
			);
			const called = await client.callTool({
				name: publishedId("sql.run"),
				arguments: {
					project_id: projectId,
					sql: "SELECT count(*)::int AS n FROM items",
				},
			});
			expect(called.isError).not.toBe(true);
			expect(called.structuredContent).toEqual({
				data: { rows: [{ n: 4 }], totalRowCount: 1, truncated: false },
			});
		} finally {
			await client.close();
			await server.close();
		}
	});
});

describe("e2e — @neon/tools docs and feedback tools", () => {
	const tools = createNeonTools({
		tools: ["docs.search", "docs.get", "feedback.send"],
	});

	it("docs.search queries neon.com without an API key", async () => {
		const { data } = await tools["docs.search"].execute({
			query: "branching",
			limit: 3,
		});
		expect(data.hits.length).toBeGreaterThan(0);
		expect(data.hits.length).toBeLessThanOrEqual(3);
		expect(data.hits[0]).toEqual({
			title: expect.any(String),
			url: expect.any(String),
			slug: expect.any(String),
			category: expect.any(String),
			breadcrumb: expect.any(Array),
			heading: expect.any(String),
			excerpt: expect.any(String),
		});
	});

	it("docs.get reads a page as markdown without an API key", async () => {
		const { data } = await tools["docs.get"].execute({
			slug: "docs/introduction/branching",
		});
		expect(data.url).toBe(
			"https://neon.com/docs/introduction/branching.md",
		);
		expect(data.markdown).toContain("Branching");
		const missing = tools["docs.get"].execute({
			slug: "docs/does-not-exist-e2e",
		});
		await expect(missing).rejects.toBeInstanceOf(NeonClientError);
		await expect(missing).rejects.toThrow(
			'Doc page not found: "docs/does-not-exist-e2e.md"',
		);
		await expect(
			tools["docs.get"].execute({ slug: "../etc/passwd" }),
		).rejects.toThrow('path traversal ("..") is not allowed');
	});

	it("feedback.send posts { feedback, source } and needs no API key", async () => {
		const received: { body: unknown; contentType?: string }[] = [];
		const readBody = async (request: IncomingMessage) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		};
		const server = createServer(async (request, response) => {
			received.push({
				body: await readBody(request),
				contentType: request.headers["content-type"],
			});
			response.writeHead(200).end("ok");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("The feedback server has no TCP address");
		}
		const { port } = address;
		try {
			const feedbackUrl = `http://127.0.0.1:${port}/`;
			const local = createNeonTools({
				tools: ["feedback.send"],
				feedbackUrl,
			});
			const { data } = await local["feedback.send"].execute({
				feedback: "  The SQL tools work.  ",
			});
			expect(data).toEqual({ message: "Feedback received. Thank you!" });
			const fromMcp = createNeonTools({
				tools: ["feedback.send"],
				feedbackUrl,
				feedbackSource: "neon_mcp",
			});
			await fromMcp["feedback.send"].execute({ feedback: "Second" });
			expect(received).toEqual([
				{
					body: {
						feedback: "The SQL tools work.",
						source: "neon_tools",
					},
					contentType: "application/json",
				},
				{
					body: { feedback: "Second", source: "neon_mcp" },
					contentType: "application/json",
				},
			]);
		} finally {
			server.close();
		}
	});
});
