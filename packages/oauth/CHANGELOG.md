# @neon/oauth

## 0.1.0

### Minor Changes

- c93da1d: Add `@neon/oauth` (beta): OAuth helpers for apps that use Neon Auth as an OAuth provider. `createOAuth` signs users in with the authorization-code flow and PKCE (encrypted session cookies, coalesced token refresh, `client.withAccessToken`) and verifies access tokens for your APIs; `oauth.client` is typed as present only when the client settings are provided. `@neon/oauth/mcp` protects MCP servers (RFC 9728 metadata, RFC 6750 challenges) and, like `@neon/oauth/verify`, depends on `jose` only. Adapters for Hono, Express, Next.js and `node:http` are included.
