---
"@neon/oauth": minor
---

Rewrite the API reference docs (JSDoc, README, adapter guide). Type-only breaking change: `McpResourceServer`, exported from `@neon/oauth`, `@neon/oauth/adapter` and `@neon/oauth/mcp`, is renamed `McpAuth`; replace `McpResourceServer` with `McpAuth` in your imports. There is no deprecated alias and no runtime change. `McpAuth` is now an explicit interface whose `issuer`, `resource`, `resourceMetadataUrl` and `metadataPaths` are `readonly` (as is `Verifier.issuer`), so code that assigns to them no longer compiles.
