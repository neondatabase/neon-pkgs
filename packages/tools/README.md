# `@neon/tools`

Generated agent tools for every operation in the Neon Management API. Select only the operations an agent needs, then use the canonical descriptors directly or adapt them for MCP, Eve, or Mastra.

```bash
npm install @neon/tools
```

## Create tools

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
	query: { limit: 10 },
});
```

The returned record is keyed by OpenAPI operation ID. Each tool includes its generated Zod 4 `inputSchema`, snake-case `id`, title, description, safety annotations, stability metadata, and an `execute()` function. Inputs group API parameters under `path`, `query`, `headers`, and `body`.

`execute()` validates the input and returns `{ data }`. Neon SDK errors remain typed and are thrown to the caller.

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

Existing MCP 1.x servers can use the isolated compatibility entry point:

```ts
import { registerNeonTools } from "@neon/tools/mcp-v1";
```

The adapter returns both text content and object-valued `structuredContent`. Execution failures use `isError: true` with structured error data.

MCP annotations are advisory; the protocol does not enforce approval. Tools expose `neon/requiresApproval` in MCP `_meta`. Hosts must read that value and enforce their own approval policy before execution.

## Eve

Eve requires Node.js 24 or later.

```ts
import { defineTool } from "eve/tools";
import { createNeonTool } from "@neon/tools";
import { toEveTool } from "@neon/tools/eve";

const apiKey = process.env.NEON_API_KEY;
if (!apiKey) throw new Error("NEON_API_KEY is required");

const createProject = defineTool(
	toEveTool(
		createNeonTool("createProject", {
			apiKey,
		}),
	),
);
```

The adapter maps approval requirements to Eve's `approval` hook and forwards its abort signal.

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
	path: {
		project_id: "project-id",
		branch_id: "branch-id",
		slug: "hello",
	},
	body: { zip: "UEsDBA==" },
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
