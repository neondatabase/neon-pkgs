# `@neon/tools`

Agent tools for the Neon Management API and for the `@neon/sdk` workflows that attach compute and return a connection string. Select only the operations and workflows an agent needs, then use the canonical descriptors directly or adapt them for MCP, Eve, and Mastra.

```bash
npm install @neon/tools
```

## Create tools

`apiKey` is a Bearer credential: a Neon API key or a Neon OAuth access token. A function is called on every request, which is how short-lived OAuth tokens get refreshed. A credential is required when a tool executes — at construction, on `execute()`, or from MCP `authInfo` — and an empty value is rejected rather than ignored.

```ts
import { createNeonTools } from "@neon/tools";

const apiKey = process.env.NEON_API_KEY;
if (!apiKey) throw new Error("NEON_API_KEY is required");

const operations = ["listProjects", "createProject"] as const;

const tools = createNeonTools({
	apiKey,
	operations,
});

const result = await tools.listProjects.execute({
	limit: 10,
});
```

OAuth access tokens use the same option. Pass a getter when the token can change:

```ts
const tools = createNeonTools({
	apiKey: () => oauth.getAccessToken(),
	operations,
});
```

Or supply the token per call:

```ts
const tools = createNeonTools({ operations });

await tools.listProjects.execute(
	{ limit: 10 },
	{ apiKey: oauthAccessToken },
);
```

The returned record is keyed by OpenAPI operation ID or SDK workflow method name. Each tool includes its Zod 4 `inputSchema`, snake-case `id`, title, description, safety annotations, stability metadata, and an `execute()` function. Inputs are flat: path, query, header, and body fields sit on one object. A body that is a single object wrapper is lifted, so `create_project` takes `{ name, region_id, org_id, ... }` rather than `{ project: { name } }`. A body with several properties keeps those properties, so `create_project_branch` takes `{ project_id, branch, endpoints, annotation_value }` and `branch` is still an object. Two email-provider updates keep a `body` field because the API request is a discriminated union.

`operationIds` exports every valid operation selector. `execute()` strictly validates the input, rejects unknown fields instead of dropping them, and returns typed, JSON-safe `{ data }`. Neon SDK errors remain typed and are thrown to the caller.

## Workflows

`workflows` selects methods from the `@neon/sdk` ergonomic client. These are not OpenAPI operations: they attach a default compute, wait until the resource is ready, and return a connection string. `operations` is the generated Management API. At least one of the two arrays is required.

Both workflow tools poll until the resource is ready. The default deadline is five minutes (`wait.timeoutMs`). Pass `wait: { timeoutMs: 30_000 }` on `createNeonTools` or `createNeonTool` to bound that. Set it below the host's own tool-call timeout, otherwise the host gives up first. An abort `signal` on `execute` or a wait timeout stops the poll, not the create: the branch or project may already exist, and the error does not include its id. List before retrying. `metadata.method` and `metadata.path` name the first request; extra readiness GETs are not listed there. `inject.projectId` still works on `createWithCompute` because its path is `/projects/{project_id}/branches`.

```ts
const tools = createNeonTools({
	apiKey,
	operations: ["listProjects"],
	workflows: ["createWithCompute", "createAndConnect"],
});

const { data } = await tools.createWithCompute.execute({
	project_id: "project-id",
	name: "feature-x",
});

await tools.createAndConnect.execute({
	name: "agent-project",
	region_id: "aws-us-east-1",
});
```

`createNeonTool` accepts the same workflow ids:

```ts
const createBranch = createNeonTool("createWithCompute", { apiKey });
```

`workflowIds` lists the selectors. Record keys match the SDK method names (`createWithCompute`, `createAndConnect`). Published ids are `create_with_compute` and `create_and_connect`. Input fields are snake_case, same as generated tools. `names` can rename a workflow the same way it renames an operation:

```ts
const tools = createNeonTools({
	apiKey,
	workflows: ["createWithCompute"],
	names: { createWithCompute: "create_branch" },
});

tools.createWithCompute.id; // "create_branch"
```

`create_project_branch` still creates a branch with no compute when `endpoints` is omitted. It can attach compute if you pass `endpoints`; it does not wait or return a connection string. Use `createWithCompute` when the next step needs to connect.

## Optional host add-ons

None of these change the default `createNeonTools({ apiKey, operations })` path. They exist so a host can replace hand-written Management API tools without losing descriptions, call tracking, or a grant-scoped project/branch.

### Descriptions

Pass a map keyed by OpenAPI operation ID or snake-case tool `id`, or a function that can append to the generated text:

```ts
const tools = createNeonTools({
	apiKey,
	operations,
	descriptions: {
		listProjects:
			"List Neon projects in your account. Do not use for projects shared with you.",
		delete_project:
			"Delete a Neon project and all its data. NEVER run autonomously; always ask the user first.",
	},
});

const noticed = createNeonTools({
	apiKey,
	operations,
	descriptions: (tool) => `${tool.description}\nNotice: scoped to one project.`,
});
```

### Tracking

`onExecute` wraps the call. The host must call `event.execute()`. That inner call performs getter resolution, path injection, original schema validation, auth, and the API request, so tracking and spans see those failures:

```ts
const tools = createNeonTools({
	apiKey,
	operations,
	onExecute: async ({ id, execute }) => {
		// record `id`, wrap in a span, then:
		return execute();
	},
});
```

This package does not send analytics. Mutating `event.input` does not change a grant-locked project or branch id.

### Names

`name` rewrites every published tool `id`. `names` overrides one tool first, keyed by OpenAPI operation ID or the generated snake-case `id`:

```ts
const tools = createNeonTools({
	apiKey,
	operations: ["createProjectBranch", "listProjects"] as const,
	names: { createProjectBranch: "create_branch" },
	name: (id) => `neon_${id}`,
});

tools.createProjectBranch.id; // "neon_create_branch"
tools.listProjects.id; // "neon_list_projects"
```

The record is still keyed by operation ID (`tools.createProjectBranch`). MCP and Mastra publish `tool.id`. Eve uses the filename as the model-facing name, so name the file after the published `id`. Duplicate or non-snake-case ids throw, and a `names` key that matches no selected tool throws.

### Project and branch injection

Tools take path parameters as `project_id` and `branch_id`. A host that already knows those values can inject them, including on `createWithCompute`. Without `omitFromSchema`, the published field becomes optional and a caller-supplied value wins. With `omitFromSchema: true`, the field is removed from the published schema and the injector is the only source:

```ts
const tools = createNeonTools({
	apiKey,
	operations: ["getProject", "deleteProjectBranch"] as const,
	inject: {
		projectId: "project-id",
		omitFromSchema: true,
	},
});

await tools.getProject.execute({});
await tools.deleteProjectBranch.execute({ branch_id: "br-id" });
```

Use a getter when the value is request-scoped. The getter can read the host's own `AsyncLocalStorage` (this package does not export one):

```ts
import { AsyncLocalStorage } from "node:async_hooks";

const grant = new AsyncLocalStorage<{ projectId: string }>();

const tools = createNeonTools({
	operations: ["getProject"] as const,
	inject: {
		projectId: () => grant.getStore()?.projectId,
		omitFromSchema: true,
	},
});

await grant.run({ projectId: "project-id" }, () => tools.getProject.execute({}));
```

Injectors only apply to tools that have that path key. `listProjects` is unchanged. Empty inject values fail closed. Invalid ids still fail the original path schema before fetch.

`onExecute` and `inject` apply to workflow tools the same way they apply to generated tools. Grant filtering, read-only filtering, and access-control notices stay in the host.

Injection reads the URL template, so it fills path `project_id` and `branch_id` only. Query and body fields with those names stay caller-supplied, including `getConnectionURI.branch_id`, `createOrgApiKey.project_id`, `createNeonAuthIntegration.project_id` / `branch_id`, `createNeonAuthNewUser.project_id`, `createNeonAuthProviderSDKKeys.project_id`, `transferNeonAuthProviderProject.project_id`, `addProjectJWKS.branch_id`, `createProjectEndpoint.branch_id`, `updateProjectEndpoint.branch_id`, and `getProjectAdvisorSecurityIssues.branch_id`. `omitFromSchema: true` does not hide those fields.

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

These are the raw OpenAPI request shapes, not the flat tool input. `zCreateProjectBody` still wraps fields in `project`. The tool `create_project` does not.

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
	operations: ["listProjects", "createProject"] as const,
});

registerNeonTools(server, tools);
```

For a remote MCP server that already authenticated the client, omit `apiKey` at construction. `registerNeonTools` sends `authInfo.token` as the Bearer credential: MCP 2.x `http.authInfo.token`, MCP 1.x `authInfo.token`. The host must put a Neon API key or Neon OAuth access token there. A present `authInfo` with an empty token is an error, not a fall back to a constructor key.

```ts
const tools = createNeonTools({
	operations: ["listProjects", "createProject"] as const,
});
registerNeonTools(server, tools);
```

This package does not implement an OAuth authorization server. That is [mcp-server-neon](https://github.com/neondatabase/mcp-server-neon) at `mcp.neon.tech`.

Existing MCP 1.x servers can use the version-specific entry point:

```ts
import { registerNeonTools } from "@neon/tools/mcp-v1";
```

The adapter returns both text content and object-valued `structuredContent`. Execution failures use `isError: true` with structured error data.

MCP annotations are advisory; the protocol does not enforce approval. Tools expose `neon/requiresApproval` in MCP `_meta`. Hosts must read that value and enforce their own approval policy before execution.

## Eve

Eve requires Node.js 24 or later.

```ts
// agent/tools/create_project.ts
import { defineTool } from "eve/tools";
import { createNeonTool } from "@neon/tools";
import { toEveTool } from "@neon/tools/eve";

const apiKey = process.env.NEON_API_KEY;
if (!apiKey) throw new Error("NEON_API_KEY is required");

export default defineTool(
	toEveTool(
		createNeonTool("createProject", {
			apiKey,
		}),
	),
);
```

Eve uses the filename as the model-facing tool name, so name the file after the tool's snake-case `id`. The adapter maps approval requirements to Eve's `approval` hook and forwards its abort signal.

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
	operations: ["listProjects", "createProject"] as const,
});
const configs = toMastraTools(neonTools);

const listProjects = createTool(configs.list_projects);
const createProject = createTool(configs.create_project);
```

The adapter maps approval requirements to Mastra's `requireApproval` field and forwards its abort signal.

## Safety and binary data

Every non-read operation is conservatively marked as potentially destructive and requires approval. Reads that return connection credentials, role passwords, or Neon Auth provider secrets also require approval.

Binary request fields accept base64 strings:

```ts
import { createNeonTool } from "@neon/tools";

const apiKey = process.env.NEON_API_KEY;
if (!apiKey) throw new Error("NEON_API_KEY is required");

const deployFunction = createNeonTool(
	"createProjectBranchFunctionDeployment",
	{ apiKey },
);

await deployFunction.execute({
	project_id: "project-id",
	branch_id: "branch-id",
	slug: "hello",
	zip: "UEsDBA==",
});
```

Binary responses are JSON-safe:

```ts
{
	data: {
		base64: "aGVsbG8=",
		contentType: "application/octet-stream",
		size: 5,
	},
}
```

`@neon/tools` supports Node.js 20.19 or later. Framework integrations also require the Node.js version supported by that framework.
