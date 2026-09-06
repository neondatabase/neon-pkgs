# `@neon/tools`

Agent tools for the `@neon/sdk` ergonomic client. Select the methods an agent needs, then use the descriptors directly or adapt them for MCP, Eve, and Mastra.

```bash
npm install @neon/tools
```

## Create tools

Selectors are SDK paths. The returned record is keyed by those paths. Each tool's published `id` is the last path segment, then the resource, in snake_case (`projects.list` → `list_projects`, `postgres.roles.resetPassword` → `reset_password_postgres_roles`, `postgres.connectionString` → `connection_string_postgres`). `publishedId` derives that string. `toolIds` lists every published selector.

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

## Writes and waiting

Tools run with `waitForReadiness: true` unless you pass `wait: false`. When a mutation response includes an `operations` array, the call waits until those operations finish. The default deadline is five minutes (`wait.timeoutMs`). Pass `wait: { timeoutMs: 30_000 }` on `createNeonTools` or `createNeonTool` to bound that. Set it below the host's own tool-call timeout, otherwise the host gives up first. Pass `wait: false` to return immediately with the created resource and its `operations`.

An abort `signal` on `execute` or a wait timeout stops the poll, not the create: the branch or project may already exist, and the error does not include its id. List before retrying.

`functions.deploy` can still return `pending`. Its response has no `operations` array, so the tool does not poll.

`metadata.method` and `metadata.path` name the first request; extra readiness GETs are not listed there.

These public client methods are not tools: `operations.waitFor`, `postgres.roles.password`, and `storage.objects.get`. Waiting is what the write tools already do. `projects.create` and `branches.create` return the created resource without a connection string; `createAndConnect` returns a URI.

## Optional host add-ons

### Descriptions

Pass a map keyed by SDK path or the current published `id`, or a function that can append to the generated text. A key that matches neither is ignored.

Generated Management API tools use the first sentence of the OpenAPI description (title stays the OpenAPI summary). Composed tools keep their handwritten copy. Hosts that need more still pass `descriptions`.

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

MCP 1.x still receives Zod input schemas, including handwritten `.describe()` copy. Generated Zod has no OpenAPI field essays. Use `compactJsonSchema` if you convert those schemas yourself and need `$schema` removed.

The adapter returns both text content and object-valued `structuredContent`. Execution failures use `isError: true` with structured error data.

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

Eve uses the filename as the model-facing tool name, so name the file after the published `id`. The adapter maps approval requirements to Eve's `approval` hook and forwards its abort signal.

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

The adapter maps approval requirements to Mastra's `requireApproval` field and forwards its abort signal.

## Safety and binary data

Every non-read operation is conservatively marked as potentially destructive and requires approval. Reads that return connection credentials also require approval.

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
