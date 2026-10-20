---
"@neon/oauth": minor
---

**Breaking (types only):** `McpResourceServer` is renamed `McpAuth`. It was exported from `@neon/oauth`, `@neon/oauth/adapter` and `@neon/oauth/mcp`; there is no deprecated alias and no runtime change. `McpAuth` is now an explicit interface whose `issuer`, `resource`, `resourceMetadataUrl` and `metadataPaths` are `readonly` (as is `Verifier.issuer`), so code that assigns to them no longer compiles.

```diff
-import type { McpResourceServer } from "@neon/oauth/mcp";
+import type { McpAuth } from "@neon/oauth/mcp";
```

Also rewrites the API reference docs: JSDoc with params, returns, throws and defaults for every export, self-contained examples, and a README with prerequisites and a quickstart.
