---
"@neon/oauth": minor
---

**Breaking (0.x minor):**

- `req.auth` is now the MCP SDK's `AuthInfo` in `expressMcp`, `expressMcpBearerAuth`, `nodeMcp` and `nodeMcpBearerAuth`, so `transport.handleRequest(req, res, req.body)` works as is. The verified `AuthResult` moved to `req.authResult`. Delete any `Object.assign(req, { auth: auth.toAuthInfo(...) })` swap: `toAuthInfo` would now receive an `AuthInfo` and throw at runtime in plain JS. Read `(req as AuthedRequest).authResult` where you used `.auth`. `AuthedRequest` and `AuthedIncomingMessage` types changed to match. The non-MCP adapters keep `AuthResult` on `req.auth`.
- Bearer guards (`honoBearerAuth`, `expressBearerAuth`, `nodeBearerAuth`, `withAuth` and the MCP variants) are built once, when the middleware is created. A missing audience now throws `OAuthConfigError` at creation instead of failing every request, and so does `resourceMetadataUrl: true` with an audience that is not an absolute URL (previously a `TypeError` on every request). `authenticate()` still builds its guard on each call and rejects.

Also:

- `nodeBearerAuth` and `expressBearerAuth` also set `req.authResult` (the same `AuthResult` as `req.auth`), so routes can read it the same way across adapters.
- `@neon/oauth/mcp/express` re-exports `NodeMcpOptions`.
- `@neon/oauth` re-exports the `SameSite` type used by `CookieOptions`.
- Docs polish: complete entry-point appendix, units in the defaults table, `@returns` on the remaining helpers, and valid TypeScript in the `ADAPTERS.md` snippets.
