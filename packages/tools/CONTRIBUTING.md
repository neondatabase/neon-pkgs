# Contributing to `@neon/tools`

## Descriptions

Agents choose a tool and fill its arguments from the tool description and the input schema. Every public tool and every top-level input has a description, and the tests fail when one is missing or over budget.

Descriptions are generated from the OpenAPI spec where the spec is good enough, and written by hand where it is not. Three layers, each overriding the one below:

| Layer | Where | Use it when |
| --- | --- | --- |
| Generated | `pnpm generate` from `packages/sdk/spec/neon-openapi.json` | Default. Tool descriptions are the first sentence of the operation description. Input descriptions are the first sentence of the parameter or property description |
| `@neon/tools` | `scripts/input-descriptions.json` for generated inputs, `.describe()` in `src/lib/ergonomic/` for composed tools, the tool `description` in `src/lib/ergonomic/` | The spec has no description, or the generated sentence is wrong or useless to an agent |
| Host | `descriptions` option, or the host's own schema (as in `mcp-server-neon`) | One consumer needs different copy |

`scripts/input-descriptions.json` is keyed by OpenAPI `operationId`, then by published input name:

```json
{
	"setProjectMemberRole": {
		"confirm_self_demotion": "Set true to lower your own role on the project."
	}
}
```

`pnpm generate` fails when an entry names an operation or input that no longer exists, so stale overrides cannot pile up.

### Budgets

`src/generation.test.ts` and `src/mcp.test.ts` enforce:

| Rule | Limit |
| --- | --- |
| Every public tool has a non-empty description | at most 500 characters |
| Generated tool descriptions | under 220 characters |
| Every top-level input has a non-empty description | at most 240 characters, no markdown links |
| `listTools` for every public tool | under 40,000 estimated tokens (characters / 4) |

Every `listTools` call carries these strings, so write the shortest sentence that tells an agent what to pass. Don't restate the type, enum values, or bounds; the JSON Schema already has them.

### Filling a gap

When a spec refresh or a new composed tool leaves an input undocumented, the description test names it. Fix it in the lowest layer that works:

1. **The spec has a description that the generator drops.** Fix the generator (`openapi-ts.config.ts` patches the spec before parsing; `scripts/generate-tools.mjs` compacts the output).
2. **The spec has no description, or a bad one.** Add an entry to `scripts/input-descriptions.json`, written from what the spec says about that operation, and report the gap to the spec's owners.
3. **A composed tool builds its own schema.** Add `.describe()` where the schema is built.

Never weaken a budget or exclude a tool to make the test pass.
