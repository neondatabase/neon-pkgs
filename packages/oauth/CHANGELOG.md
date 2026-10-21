# @neon/oauth

## 0.2.0

### Minor Changes

- d1a941f: **Breaking (types only):** `McpResourceServer` is renamed `McpAuth`. It was exported from `@neon/oauth`, `@neon/oauth/adapter` and `@neon/oauth/mcp`; there is no deprecated alias and no runtime change. `McpAuth` is now an explicit interface whose `issuer`, `resource`, `resourceMetadataUrl` and `metadataPaths` are `readonly` (as is `Verifier.issuer`), so code that assigns to them no longer compiles.

  ```diff
  -import type { McpResourceServer } from "@neon/oauth/mcp";
  +import type { McpAuth } from "@neon/oauth/mcp";
  ```

  Also rewrites the API reference docs: JSDoc with params, returns, throws and defaults for every export, self-contained examples, and a README with prerequisites and a quickstart.

## 0.1.0

### Minor Changes

- c93da1d: Add `@neon/oauth` (beta): OAuth helpers for apps that use Neon Auth as an OAuth provider. `createOAuth` signs users in with the authorization-code flow and PKCE (encrypted session cookies, coalesced token refresh, `client.withAccessToken`) and verifies access tokens for your APIs; `oauth.client` is typed as present only when the client settings are provided. `@neon/oauth/mcp` protects MCP servers (RFC 9728 metadata, RFC 6750 challenges) and, like `@neon/oauth/verify`, depends on `jose` only. Adapters for Hono, Express, Next.js and `node:http` are included.
