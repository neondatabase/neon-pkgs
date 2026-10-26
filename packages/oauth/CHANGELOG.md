# @neon/oauth

## 0.3.0

### Minor Changes

- 4aa0c09: **Breaking (0.x minor):**

  - `req.auth` is now the MCP SDK's `AuthInfo` in `expressMcp`, `expressMcpBearerAuth`, `nodeMcp` and `nodeMcpBearerAuth`, so `transport.handleRequest(req, res, req.body)` works as is. The verified `AuthResult` moved to `req.authResult`. Delete any `Object.assign(req, { auth: auth.toAuthInfo(...) })` swap: `toAuthInfo` would now receive an `AuthInfo` and throw at runtime in plain JS. Read `(req as AuthedRequest).authResult` where you used `.auth`. `AuthedRequest` and `AuthedIncomingMessage` types changed to match. The non-MCP adapters keep `AuthResult` on `req.auth`.
  - Bearer guards (`honoBearerAuth`, `expressBearerAuth`, `nodeBearerAuth`, `withAuth` and the MCP variants) are built once, when the middleware is created. A missing audience now throws `OAuthConfigError` at creation instead of failing every request, and so does `resourceMetadataUrl: true` with an audience that is not an absolute URL (previously a `TypeError` on every request). `authenticate()` still builds its guard on each call and rejects.

  Also:

  - `nodeBearerAuth` and `expressBearerAuth` also set `req.authResult` (the same `AuthResult` as `req.auth`), so routes can read it the same way across adapters.
  - `@neon/oauth/mcp/express` re-exports `NodeMcpOptions`.
  - `@neon/oauth` re-exports the `SameSite` type used by `CookieOptions`.
  - Docs polish: complete entry-point appendix, units in the defaults table, `@returns` on the remaining helpers, and valid TypeScript in the `ADAPTERS.md` snippets.

### Patch Changes

- 2e44c6b: Fix: the MCP adapters (`expressMcp`, `nodeMcp`, `honoMcp`) now require a bearer token on every request routed to the MCP endpoint, including path variants (case, trailing slash, percent-encoding) and methods beyond POST/GET/DELETE; `OPTIONS` stays open for CORS preflight. `returnTo` on login and logout now only accepts same-origin paths. Custom MCP adapters should use the new `isGuardedMcpRequest` instead of comparing `MCP_METHODS` and the path themselves.

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
