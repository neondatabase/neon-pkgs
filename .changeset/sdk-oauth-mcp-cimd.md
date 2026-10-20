---
"@neon/sdk": minor
"@neon/tools": minor
---

Refresh the vendored Neon API spec for Neon Auth OAuth provider MCP settings. `NeonAuthOAuthProviderMcp` and `NeonAuthOAuthProviderMcpUpdate` gain `client_id_metadata_documents`, which controls whether MCP clients may identify themselves with an https Client ID Metadata Document (CIMD) URL. `dynamic_registration` is now documented as legacy and defaults to `false`. The `@neon/tools/schemas` request schemas accept the new field.
