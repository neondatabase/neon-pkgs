# `@neon/tools`

Agent tools for the `@neon/sdk` ergonomic client. Select the methods an agent needs, then use the descriptors directly or adapt them for MCP, Eve, and Mastra.

```bash
npm install @neon/tools
```

## Create tools

Selectors are SDK paths, plus the custom tools listed in `customToolIds` (see [Custom tools](#custom-tools)). The returned record is keyed by those selectors. Each tool's published `id` is the last path segment, then the resource, in snake_case (`projects.list` → `list_projects`, `postgres.roles.resetPassword` → `reset_password_postgres_roles`, `postgres.connectionString` → `connection_string_postgres`). `publishedId` derives that string. `toolIds` lists every published selector.

```ts
import { createNeonTools, publishedId } from "@neon/tools";

publishedId("projects.list"); // "list_projects"
publishedId("postgres.roles.resetPassword"); // "reset_password_postgres_roles"

const apiKey = process.env.NEON_API_KEY;
if (!apiKey) throw new Error("NEON_API_KEY is required");

const tools = createNeonTools({
	apiKey,
	tools: [
		"projects.list",
		"projects.createAndConnect",
		"branches.createAndConnect",
		"branches.resetFromParent",
		"branches.compareSchema",
	],
});

const listed = await tools["projects.list"].execute({ limit: 10 });
const created = await tools["projects.createAndConnect"].execute({
	name: "agent-project",
	region_id: "aws-us-east-1",
});
await tools["branches.resetFromParent"].execute({
	project_id: "project-id",
	branch_id: "br-feature",
	preserve_under_name: "feature-before-reset",
});
const compared = await tools["branches.compareSchema"].execute({
	project_id: "project-id",
	branch_id: "br-feature",
	database_name: "neondb",
});
```

Trigger create keeps the discriminator nested as `body`. `type` is `"schedule"` or `"storage_object_created"`:

```ts
const triggerTools = createNeonTools({
	apiKey,
	tools: ["triggers.create"],
});
const createdTrigger = await triggerTools["triggers.create"].execute({
	project_id: "project-id",
	branch_id: "br-feature",
	body: {
		type: "schedule",
		function_slug: "worker",
		name: "daily-refresh",
		schedule: { cron: "0 9 * * *" },
	},
});
const createdStorageTrigger = await triggerTools["triggers.create"].execute({
	project_id: "project-id",
	branch_id: "br-feature",
	body: {
		type: "storage_object_created",
		function_slug: "ingest",
		name: "uploads",
		storage_object_created: { bucket_name: "uploads", prefix: "incoming/" },
	},
});
```

`limit` on a list tool caps how many items come back.

MCP and Mastra publish `tool.id` (`list_projects`), not the record key.

`apiKey` is a Bearer credential: a Neon API key or a Neon OAuth access token. A function is called on every request, which is how short-lived OAuth tokens get refreshed. A credential is required when a tool executes — at construction, on `execute()`, or from MCP `authInfo` — and an empty value is rejected rather than ignored.

```ts
const tools = createNeonTools({
	apiKey: () => oauth.getAccessToken(),
	tools: ["projects.list"],
});

await tools["projects.list"].execute(
	{ limit: 10 },
	{ apiKey: oauthAccessToken },
);
```

Each tool includes its Zod 4 `inputSchema`, published `id`, title, description, safety annotations, stability metadata, and `execute()`. Inputs are snake_case at the tool boundary. `execute()` strictly validates the input, rejects unknown fields, and returns typed, JSON-safe `{ data }`. Neon SDK errors remain typed and are thrown to the caller.

Paginated lists call `.all()` and return the item array. Do not pass a cursor; those fields are omitted from the input schema.

```ts
const createBranch = createNeonTool("branches.createAndConnect", { apiKey });
```

## Custom tools

Custom tools combine several requests into one call, or call Postgres or neon.com, and are not a single `NeonClient` method. They are selected, adapted, and executed like every other tool. `customToolIds` lists them.

| Selector | Published id | Returns |
| --- | --- | --- |
| `auth.getConfig` | `get_config_auth` | The branch's Neon Auth integration and settings: trusted origins, localhost access, email and password, OAuth providers, email provider, the organization, magic link, and phone number plugins, and the webhook. `branch_id` defaults to the project's default branch. |
| `resources.search` | `search_resources` | `{ results: [{ id, title, url }] }` for organizations, projects (including projects shared with the user), and branches whose name or id contains `query`. The id prefix (`org:`, `project:`, `branch:<project>/<branch>`) names the kind. |
| `resources.fetch` | `fetch_resources` | `{ id, title, text, url, metadata }` for an id from `resources.search`: markdown details in `text`, the console URL, and the organization with members and projects, the project with branches, or the `branches.describe` result in `metadata`. |
| `sql.run` | `run_sql` | `{ rows, totalRowCount, truncated, note? }` for one statement. `rows` holds at most `max_rows` (default 100, at most 10,000). |
| `sql.runTransaction` | `run_transaction_sql` | One `{ rows, totalRowCount, truncated, note? }` per statement, run in one transaction. |
| `sql.explain` | `explain_sql` | The `EXPLAIN (FORMAT JSON)` rows. `analyze: true` executes the statement. |
| `schema.listTables` | `list_tables_schema` | `{ table_schema, table_name, table_type }` for every table outside `pg_catalog` and `information_schema`. |
| `schema.describeTable` | `describe_table_schema` | `{ raw, formatted }`: columns, indexes, constraints, and sizes. A missing table throws `NeonClientError`. |
| `branches.describe` | `describe_branches` | `{ branch, console_url, text, database_structure }`, where `database_structure` is the object tree from a temporary `show_db_tree()` function. When that query fails it is `null` and `database_structure_error` says why. |
| `queries.listSlow` | `list_slow_queries` | `{ slow_queries, total_queries_found }` from `pg_stat_statements`, slowest mean time first. Without the extension it throws `NeonClientError`. |
| `database.inspect` | `inspect_database` | One `neon inspect db` check: `{ check, describe, projectId, branchId, databases, fields, totalRowCount, rows, truncated, note? }`. |
| `migrations.prepare` | `prepare_migrations` | Runs `migration_sql` on a new temporary branch and returns `{ complete, temporary_branch, migration_result }`. `complete` holds exactly the fields `migrations.complete` takes (`migration_id`, `migration_sql`, `database_name`, `project_id`, `temporary_branch_id`, `parent_branch_id`); `temporary_branch` is `{ id, name, parent_id }`; `migration_result` holds each statement's rows. |
| `migrations.complete` | `complete_migrations` | Applies the migration to the parent unless `apply_changes` is false, deletes the temporary branch, and returns `{ applied, deletedBranchId?, cleanupError?, migrationResult? }`. |
| `queryTuning.prepare` | `prepare_query_tuning` | Runs `EXPLAIN ANALYZE` on a new temporary branch and returns `{ complete, execution_plan, table_schemas, sql, baseline_metrics }`. `complete` holds `tuning_id`, `database_name`, `project_id`, `temporary_branch_id`, and `role_name` when one was passed; `baseline_metrics` holds time, cost, rows, and buffer counters of the root plan node. |
| `queryTuning.complete` | `complete_query_tuning` | Applies `suggested_sql_statements` when `apply_changes` is true, deletes the temporary branch unless `should_delete_temporary_branch` is false, and returns `{ appliedChanges?, results?, deletedBranches?, message }`. |
| `docs.search` | `search_docs` | `{ hits: [{ title, url, slug, category, breadcrumb, heading, excerpt }] }` from neon.com site search. |
| `docs.get` | `get_docs` | `{ url, markdown }` for one neon.com page slug. |
| `feedback.send` | `send_feedback` | Posts `{ feedback, source }` to the Neon feedback service. |

```ts
const tools = createNeonTools({
	apiKey,
	tools: ["auth.getConfig", "resources.search", "resources.fetch", "sql.run"],
});

const { data: config } = await tools["auth.getConfig"].execute({
	project_id: "project-id",
});
config.oauth_providers; // [{ id: "google", type: "standard", client_id: "…", client_secret: "***redacted***" }]

const { data: found } = await tools["resources.search"].execute({
	query: "checkout",
});
found.results; // [{ id: "project:project-id", title: "checkout-service", url: "https://console.neon.tech/app/projects/project-id" }]

const { data: project } = await tools["resources.fetch"].execute({
	id: "project:project-id",
});
project.text; // "**Project Details**\n\n**Basic Information:**\n- Name: checkout-service\n…"
project.metadata; // { project: { id: "project-id", … }, branches: [ … ] }

const migrationTools = createNeonTools({
	apiKey,
	tools: ["migrations.prepare", "migrations.complete"],
});
const prepared = await migrationTools["migrations.prepare"].execute({
	project_id: "project-id",
	migration_sql: "ALTER TABLE users ADD COLUMN plan text",
});
await migrationTools["migrations.complete"].execute({
	...prepared.data.complete,
	apply_changes: true,
});
prepared.data.temporary_branch; // { id: "br-…", name: "mcp-migration-2026-11-06T20-05-00", parent_id: "br-main-…" }

const tuningTools = createNeonTools({
	apiKey,
	tools: ["queryTuning.prepare", "queryTuning.complete"],
});
const tuning = await tuningTools["queryTuning.prepare"].execute({
	project_id: "project-id",
	database_name: "neondb",
	sql: "SELECT * FROM orders WHERE customer_id = 42",
});
await tuningTools["queryTuning.complete"].execute({
	...tuning.data.complete,
	suggested_sql_statements: ["CREATE INDEX ON orders (customer_id)"],
	apply_changes: true,
});

const { data: result } = await tools["sql.run"].execute({
	project_id: "project-id",
	sql: "SELECT id, email FROM users ORDER BY id",
	max_rows: 2,
});
result; // { rows: [{ id: 1, email: "a@example.com" }, { id: 2, email: "b@example.com" }], totalRowCount: 40, truncated: true, note: "Showing the first 2 of 40 rows. …" }
```

`auth.getConfig` replaces OAuth client secrets and the SMTP password with `"***redacted***"`. Trusted origins, localhost access, email and password, and OAuth providers are required reads: an error on any of them fails the call, and a branch without Neon Auth throws `NeonNotFoundError`. The email provider, plugins, and webhook reads are reported under `_errors` when they fail; an email provider that was never configured is `null`.

`user.organizations` takes an optional `search` that filters by a case-insensitive part of the name or id. An organization API key gets its own organization.

`resources.search` leaves out an organization, project, or branch whose read the API refuses, and fails on any other error, including an aborted `signal`. It reads up to 400 projects per organization and 400 shared projects. `resources.fetch` reads the first page of an organization's members and projects and skips either when the API refuses it. An id without a known prefix throws `NeonClientError`. Console URLs follow `baseUrl`: `https://console.neon.tech/api/v2` links to `https://console.neon.tech`.

### SQL tools

The SQL tools resolve a connection from `project_id` (required), then `branch_id` (default branch), `database_name` (`neondb`, else the first database), `role_name` (that database's owner), and `compute_id` (the branch's read-write compute). Their `metadata.method` is `"SQL"` and `metadata.path` is `/projects/{project_id}/connection_uri`, so `inject.projectId` fills `project_id`. Whether a tool can change data is in `annotations`, not `metadata.method`.

A Postgres error rejects with the `NeonDbError` from `@neondatabase/serverless`, carrying `code` (SQLSTATE), `position`, `detail`, `hint`, and `where`. `database.inspect` throws `InspectDiagnosticError` (exported from `@neon/tools`, with `check` and the `NeonDbError` as `cause`) when Postgres rejects one of its own diagnostic queries, which is a bug in this package rather than in the input. A caller-side problem, such as a missing extension, a missing database, or a refused connection, keeps its own class.

`migrations.prepare` and `queryTuning.prepare` delete the temporary branch when anything after its creation fails, including the readiness wait (a `wait` timeout, a failed operation, or an aborted `signal`). Cleanup waits up to 60 seconds for the branch to finish provisioning before deleting it, regardless of `wait` and `signal`. `migrations.complete` applies first; if that fails the temporary branch stays so the call can be retried, and a failed delete after a successful apply is reported as `cleanupError`.

### Execution context

`execute(input, context)` takes these fields in addition to `signal` and `apiKey`:

```ts
await tools["sql.run"].execute(
	{ project_id: "project-id", sql: "SELECT count(*) FROM orders" },
	{
		readOnly: true,
		postgresRole: "app_reader",
		caller: { source: "my_host", userAgent: "my-agent/1.0", client: "cursor" },
	},
);
```

| Field | Effect |
| --- | --- |
| `readOnly` | `sql.run` and `sql.explain` run the statement in a `READ ONLY` transaction, so Postgres rejects writes. `sql.runTransaction`, `migrations.*`, and `queryTuning.*` throw `NeonClientError` without running anything, because a caller statement such as `COMMIT` or `SET TRANSACTION READ WRITE` can leave a read-only transaction. `branches.describe` still creates and drops its fixed `show_db_tree()` function. `schema.*`, `queries.listSlow`, and `database.inspect` behave the same; `database.inspect` always uses a `READ ONLY` transaction. |
| `postgresRole` | Every SQL connection logs in as this role. A `role_name` that differs throws `NeonClientError`. |
| `caller` | Sent with `docs.search` as `x-caller-source`, `x-caller-user-agent`, and `x-caller-client`. Without it, `x-caller-source` is `neon_tools`. |

### Docs and feedback

`docs.search`, `docs.get`, and `feedback.send` call neon.com and the Neon feedback service, not the Neon API, and run without `apiKey`. Each request times out after 10 seconds. `docs.get` rejects slugs that contain `..` or `://` or start with `/`. Configure the endpoints on `createNeonTools`:

```ts
const tools = createNeonTools({
	tools: ["docs.search", "docs.get", "feedback.send"],
	siteSearchUrl: "https://example.com/site-search", // default: neon.com site search
	docsBaseUrl: "https://neon.com", // docs.get reads <docsBaseUrl>/<slug>.md
	feedbackUrl: "https://feedback.neon.tech/",
	feedbackSource: "my_host", // default "neon_tools"
});

const { data } = await tools["docs.search"].execute({ query: "reset a branch" });
const { data: page } = await tools["docs.get"].execute({ slug: data.hits[0].slug });
```

## Writes and waiting

Tools run with `waitForReadiness: true`. When a mutation response includes an `operations` array, the call waits until those operations finish. The default deadline is five minutes (`wait.timeoutMs`). Pass `wait: { timeoutMs: 30_000 }` on `createNeonTools` or `createNeonTool` to bound that. Set it below the host's own tool-call timeout, otherwise the host gives up first.

An abort `signal` on `execute` or a wait timeout stops the poll, not the create: the branch or project may already exist, and the error does not include its id. List before retrying.

`functions.deploy` can still return `pending`. Its response has no `operations` array, so the tool does not poll.

`realtime.enable`, `realtime.disable`, and `realtime.rotateSecret` have no `operations` either. They poll the branch's Realtime state until `pending` is `false`, under the same `wait` budget.

`metadata.method` and `metadata.path` name the first request; extra readiness GETs are not listed there.

These public client methods are not tools: `operations.waitFor`, `postgres.roles.password`, `storage.objects.get`, and `credentials.reveal`. Waiting is what the write tools already do. `realtime.secret` is a GET that requires approval: it returns the branch's Realtime secret, which an application backend seals queries with. After `realtime.rotateSecret`, it returns the new value once `pending` is `false`. `projects.create` and `branches.create` return the created resource without a connection string; `createAndConnect` returns a URI. `triggers.create` and `triggers.update` take the OpenAPI discriminator as a nested `body` field. `credentials.rotate` requires approval and is not idempotent: a lost success already replaced the secret; create a replacement and revoke the rotated credential.

## Roles

`postgres.roles.create` (`create_postgres_roles`) defaults to `access: "admin"`, which joins `neon_superuser`. Pass `read_only` or `read_write` for a least-privilege credential. Scoped roles are created with SQL as the database owner; see [`@neon/sdk`'s `neon.postgres.roles`](../sdk/README.md#neonpostgresroles) for the grants and limits.

```ts
const tools = createNeonTools({ apiKey, tools: ["postgres.roles.create"] });
const { data: role } = await tools["postgres.roles.create"].execute({
	project_id: "project-id",
	branch_id: "br-main",
	name: "app_reader",
	access: "read_only",
	database_name: "neondb",
	schemas: ["public"],
});
// role.password is the generated password
```

## Optional host add-ons

### Descriptions

Pass a map keyed by SDK path or the current published `id`, or a function that can append to the generated text. A key that matches neither is ignored.

Generated Management API tools use the first sentence of the OpenAPI description (title stays the OpenAPI summary). Every top-level input carries a description too: the first sentence of its OpenAPI description, or handwritten copy where the spec has none. Composed tools keep their handwritten copy. Hosts that need more still pass `descriptions`.

```ts
const tools = createNeonTools({
	apiKey,
	tools: ["projects.list", "projects.delete"],
	descriptions: {
		"projects.list":
			"List Neon projects in your account. Do not use for projects shared with you.",
		delete_projects:
			"Delete a Neon project and all its data. NEVER run autonomously; always ask the user first.",
	},
});
```

### Tracking

`onExecute` wraps the call. The host must call `event.execute()`. That inner call performs getter resolution, path injection, original schema validation, auth, and the API request, so tracking and spans see those failures:

```ts
const tools = createNeonTools({
	apiKey,
	tools: ["projects.list"],
	onExecute: async ({ id, execute }) => {
		return execute();
	},
});
```

This package does not send analytics. Mutating `event.input` does not change a grant-locked project or branch id.

### Names

`name` rewrites every published tool `id`. `names` overrides one tool first, keyed by SDK path or the generated snake-case `id`:

```ts
const tools = createNeonTools({
	apiKey,
	tools: ["branches.createAndConnect", "projects.list"] as const,
	names: { "branches.createAndConnect": "create_branch" },
	name: (id) => `neon_${id}`,
});
```

Those tools publish as `neon_create_branch` and `neon_list_projects`. The record is still keyed by SDK path (`tools["branches.createAndConnect"]`). MCP and Mastra publish `tool.id`. Eve uses the filename as the model-facing name, so name the file after the published `id`. Duplicate or non-snake-case ids throw, and a `names` key that matches no selected tool throws.

### Project and branch injection

Tools take path parameters as `project_id` and `branch_id`. A host that already knows those values can inject them, including on `branches.createAndConnect`. Without `omitFromSchema`, the published field becomes optional and a caller-supplied value wins. With `omitFromSchema: true`, the field is removed from the published schema and the injector is the only source:

```ts
const tools = createNeonTools({
	apiKey,
	tools: ["projects.get", "branches.delete"] as const,
	inject: {
		projectId: "project-id",
		omitFromSchema: true,
	},
});

await tools["projects.get"].execute({});
await tools["branches.delete"].execute({ branch_id: "br-id" });
```

Use a getter when the value is request-scoped. The getter can read the host's own `AsyncLocalStorage` (this package does not export one):

```ts
import { AsyncLocalStorage } from "node:async_hooks";

const grant = new AsyncLocalStorage<{ projectId: string }>();

const tools = createNeonTools({
	tools: ["projects.get"] as const,
	inject: {
		projectId: () => grant.getStore()?.projectId,
		omitFromSchema: true,
	},
});

await grant.run({ projectId: "project-id" }, () =>
	tools["projects.get"].execute({}),
);
```

Injectors only apply to tools that have that path key. `projects.list` is unchanged. Empty inject values fail closed. Invalid ids still fail the original path schema before fetch.

Injection reads the URL template, so it fills path `project_id` and `branch_id` only. Query and body fields with those names stay caller-supplied, including `postgres.connectionString`'s `branch_id`. `omitFromSchema: true` does not hide those fields.

## Request schemas

Generated request schemas are available independently:

```ts
import {
	zCreateProjectBody,
	zListProjectsQuery,
} from "@neon/tools/schemas";

const query = zListProjectsQuery.parse({ limit: 10 });
const body = zCreateProjectBody.parse({
	project: { name: "agent-project" },
});
```

These are the raw OpenAPI request shapes, not the tool input. `zCreateProjectBody` still wraps fields in `project`. `projects.createAndConnect` does not.

These schemas are strict. If a newly added API field is not recognized, upgrade `@neon/tools`; use `@neon/sdk` directly until a matching tools release is available.

## MCP

Use `@neon/tools/mcp` with MCP 2.x:

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { createNeonTools } from "@neon/tools";
import { registerNeonTools } from "@neon/tools/mcp";

const apiKey = process.env.NEON_API_KEY;
if (!apiKey) throw new Error("NEON_API_KEY is required");

const server = new McpServer({ name: "neon", version: "1.0.0" });
const tools = createNeonTools({
	apiKey,
	tools: ["projects.list", "projects.createAndConnect"] as const,
});

registerNeonTools(server, tools);
```

`registerNeonTools` publishes that catalog. MCP 2 `inputSchema` is JSON Schema without `$schema`. Generated fields have types, enums, `required`, and constraints, and no OpenAPI property docs. Fields this package described with `.describe()` (`pooled`, `finalize`, `zip`) keep that copy.

Hosts that convert Zod themselves:

```ts
import { compactJsonSchema } from "@neon/tools/mcp";
import * as z from "zod";
import { createNeonTool } from "@neon/tools";

const tool = createNeonTool("projects.update", { apiKey });
const inputSchema = compactJsonSchema(
	z.toJSONSchema(tool.inputSchema, { io: "input" }),
);
```

For a remote MCP server that already authenticated the client, omit `apiKey` at construction. `registerNeonTools` sends `authInfo.token` as the Bearer credential: MCP 2.x `http.authInfo.token`, MCP 1.x `authInfo.token`. The host must put a Neon API key or Neon OAuth access token there. A present `authInfo` with an empty token is an error, not a fall back to a constructor key.

```ts
const tools = createNeonTools({
	tools: ["projects.list", "projects.createAndConnect"] as const,
});
registerNeonTools(server, tools);
```

This package does not implement an OAuth authorization server. That is [mcp-server-neon](https://github.com/neondatabase/mcp-server-neon) at `mcp.neon.tech`.

Existing MCP 1.x servers can use the version-specific entry point:

```ts
import { registerNeonTools } from "@neon/tools/mcp-v1";
```

MCP 1.x still receives Zod input schemas, including their `.describe()` copy. Generated Zod carries only the first sentence of each OpenAPI field description. Use `compactJsonSchema` if you convert those schemas yourself and need `$schema` removed.

The adapter returns both text content and object-valued `structuredContent`. Execution failures use `isError: true` with `{ error: { message, name, kind, status, code, source, timeoutMs, requestId, reason, operationId } }` when those fields exist on the thrown error. A wait timeout has `kind: "timeout"` and `source: "wait"`.

MCP annotations are advisory; the protocol does not enforce approval. Tools expose `neon/requiresApproval` in MCP `_meta`. Hosts must read that value and enforce their own approval policy before execution.

## Eve

Eve requires Node.js 24 or later.

`create_and_connect_projects.ts`:

```ts
import { defineTool } from "eve/tools";
import { createNeonTool } from "@neon/tools";
import { toEveTool } from "@neon/tools/eve";

const apiKey = process.env.NEON_API_KEY;
if (!apiKey) throw new Error("NEON_API_KEY is required");

export default defineTool(
	toEveTool(
		createNeonTool("projects.createAndConnect", {
			apiKey,
		}),
	),
);
```

Eve uses the filename as the model-facing tool name, so name the file after the published `id`. The adapter maps approval requirements to Eve's `approval` hook and forwards its abort signal. `abortSignal` is optional. Credentials are the constructor `apiKey` (a string or a callback invoked on every request).

## Mastra

Mastra requires Node.js 22.13 or later.

```ts
import { createTool } from "@mastra/core/tools";
import { createNeonTools } from "@neon/tools";
import { toMastraTools } from "@neon/tools/mastra";

const apiKey = process.env.NEON_API_KEY;
if (!apiKey) throw new Error("NEON_API_KEY is required");

const neonTools = createNeonTools({
	apiKey,
	tools: ["projects.list", "projects.createAndConnect"] as const,
});
const configs = toMastraTools(neonTools);

const listProjects = createTool(configs.list_projects);
const createProject = createTool(configs.create_and_connect_projects);
```

The adapter maps approval requirements to Mastra's `requireApproval` field and forwards its abort signal. Credentials are the constructor `apiKey` (a string or a callback invoked on every request).

## Safety and binary data

Every non-read operation requires approval. Generated non-read operations are conservatively marked as potentially destructive; `migrations.prepare` and `queryTuning.prepare` (which write only to a new temporary branch) and `feedback.send` are not. Reads that return connection credentials also require approval.

Binary request fields accept base64 strings:

```ts
import { createNeonTool } from "@neon/tools";

const apiKey = process.env.NEON_API_KEY;
if (!apiKey) throw new Error("NEON_API_KEY is required");

const deployFunction = createNeonTool("functions.deploy", { apiKey });

await deployFunction.execute({
	project_id: "project-id",
	branch_id: "branch-id",
	slug: "hello",
	zip: "UEsDBA==",
});
```

`@neon/tools` supports Node.js 20.19 or later. Framework integrations also require the Node.js version supported by that framework.
