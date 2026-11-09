# Contributing to `@neon/tools`

## Adding a tool for a new `@neon/sdk` method

`src/catalog.test.ts` fails when a public `NeonClient` method is neither a tool nor listed in `hiddenToolIds`, so a new SDK method arrives as a red test. To publish it:

1. If the SDK's vendored spec changed, regenerate:

   ```bash
   pnpm --filter @neon/sdk spec:pull
   pnpm --filter @neon/sdk generate
   pnpm --filter @neon/tools generate
   ```

   `pnpm generate` writes four files, all committed and checked by `pnpm generate:check`:

   | File | Holds |
   | --- | --- |
   | `src/generated/zod.gen.ts` | Request schemas per operation, descriptions cut to their first sentence |
   | `src/operations.gen.ts` | One factory per `operationId`: flattened input schema with `input-descriptions.json` applied, annotations, approval, and `metadata` |
   | `src/schemas.ts` | The request schemas `@neon/tools/schemas` exports |
   | `src/descriptions.gen.ts` | `scripts/tool-descriptions.json` and the `*` entries of `scripts/input-descriptions.json` |

2. Add the selector (the SDK path, such as `"branches.list"`) to `toolIds` in `src/lib/ergonomic/ids.ts`. A tool that is not a `NeonClient` method also goes in `customToolIds`.
3. Add its factory to `toolFactories` in `src/lib/ergonomic/catalog.ts`:
   - `fromGenerated` when the tool is one operation whose generated input the SDK method takes as is. It reuses the generated schema, title, annotations, and approval. For a paginated method, omit `cursor`, set `list: true`, and collect pages in `run` with `collectPages`.
   - A composed tool (`bindTool` in `src/lib/ergonomic/composed.ts`) when the tool needs its own input schema, for example renamed or nested fields, or an SDK method that makes several requests.
   - A custom tool (`src/lib/custom/`) when it calls Postgres, neon.com, or several SDK methods.
4. Write its description (below), and add `"<mcp name>": "<selector>"` to `scripts/mcp-tool-names.json` if the Neon MCP server publishes it.
5. Run the checks:

   ```bash
   pnpm --filter @neon/tools generate:check
   pnpm --filter @neon/tools exec tsc --noEmit
   pnpm --filter @neon/tools test:ci
   ```

## Descriptions

Agents choose a tool and fill its arguments from the tool description and the input schema. Three layers, each replacing the one below:

| Layer | Tool description | Input descriptions |
| --- | --- | --- |
| Generated | First sentence of the OpenAPI operation description | First sentence of the OpenAPI parameter or property description |
| `@neon/tools` | `scripts/tool-descriptions.json` for `fromGenerated` tools, `description` in code for composed and custom tools | `scripts/input-descriptions.json` for generated inputs, `.describe()` where a composed or custom tool builds its schema |
| Host | The `descriptions` option | The host's own schema |

A description names another tool as `{{selector}}`. `createNeonTools` and `createNeonTool` replace it with the name that tool publishes under after `names` and `name`, or its default id when it is not selected, so the same text reads `get_connection_string` on the Neon MCP server and `connection_string_postgres` with default names. Tokens work in tool descriptions, top-level input descriptions, and host `descriptions`.

`scripts/tool-descriptions.json` is keyed by selector. `list: true` tools get `Returns every page. Pass limit to cap how many.` appended, so leave pagination out:

```json
{
	"postgres.endpoints.list": "Lists the compute endpoints of every branch in a project. For one branch, use {{postgres.endpoints.listByBranch}}."
}
```

`scripts/input-descriptions.json` is keyed by OpenAPI `operationId`, then by published input name. `*` sets a path parameter's description on every operation; an operation's own entry still wins. Composed and custom tools read the same text from `pathInputDescriptions`:

```json
{
	"*": {
		"branch_id": "A br-... id, not a name."
	},
	"revokePermissionFromProject": {
		"permission_id": "The permission id from {{projects.permissions.list}}."
	}
}
```

`scripts/mcp-tool-names.json` maps every tool the Neon MCP server publishes to its selector:

```json
{
	"get_connection_string": "postgres.connectionString"
}
```

### What a description says

- The first sentence says what the tool does to which resource, in the present tense: "Lists a project's branches", not "Retrieves information about the specified branch".
- Then only what changes the agent's next call: preconditions, which sibling tool to use instead, destructive or irreversible effects, waiting, and errors a caller can avoid. Tools that overlap point at each other.
- Leave out types, enum values, defaults, and bounds; the JSON Schema has them. Say something once, in the input it is about, rather than in every tool.
- Keep "NEVER run autonomously; always ask the user first." on the destructive tools that have it.
- Every claim matches the handler or SDK method. Read it first.

### Budgets and the tests that enforce them

| Rule | Limit | Test |
| --- | --- | --- |
| Every public tool has a description | at most 500 characters | `src/generation.test.ts` |
| Generated OpenAPI tool descriptions | under 220 characters | `src/generation.test.ts` |
| Every top-level input has a description | at most 240 characters, no markdown links | `src/generation.test.ts` |
| `listTools` for every public tool | under 43,800 estimated tokens (characters / 4) | `src/mcp.test.ts` |

Never raise a budget or exclude a tool to make a test pass. These also fail when something is missing or stale:

| Failure | Where |
| --- | --- |
| A `tool-descriptions.json` key that is not a selector | `tsc` on `src/descriptions.gen.ts`, and `src/descriptions.test.ts` |
| A `tool-descriptions.json` entry the tool does not publish, such as one for a composed tool | `src/descriptions.test.ts` |
| An `input-descriptions.json` entry for an unknown operation or input, or a `*` entry no path has | `pnpm generate` |
| A `{{selector}}` that names no tool, or a token left in a published description | `src/descriptions.test.ts`; at runtime, `createNeonTools` throws |
| A `branch_id` input without the `*` text | `src/descriptions.test.ts` |
| An MCP name whose selector is not published, or an MCP tool that references a tool the MCP server does not publish | `src/descriptions.test.ts` |
| A generated file out of date | `pnpm generate:check` |

### Filling a gap

When a spec refresh or a new tool leaves an input undocumented, `src/generation.test.ts` names it. Fix it in the lowest layer that works:

1. **The spec has a description that the generator drops.** Fix the generator (`openapi-ts.config.ts` patches the spec before parsing; `scripts/generate-tools.mjs` compacts the output).
2. **The spec has no description, or a bad one.** Add an entry to `scripts/input-descriptions.json`, written from what the spec says about that operation, and report the gap to the spec's owners.
3. **A composed or custom tool builds its own schema.** Add `.describe()` where the schema is built.
