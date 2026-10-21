# Adding a framework adapter

The core speaks Web `Request`/`Response` and nothing else. An adapter is a translation layer: framework request in, Web `Request` to the core, Web `Response` out. It must not reimplement routing, challenges or metadata.

## The contract

| Function | From | Returns | Use for |
|---|---|---|---|
| `authenticate(source, request, opts?)` | `@neon/oauth/adapter` | `{ ok: true, auth } \| { ok: false, response }` | Bearer guard. `source` is an `OAuth` from `createOAuth()` or a verifier from `createVerifier()` (typed as `AuthSource`; `opts.audience` is required unless a `resource` was configured), or an `McpAuth` (the result of `createMcpAuth()`). Send `response` as-is on failure (401/403 with an RFC 6750 `WWW-Authenticate`, 503 when the authorization server is unavailable, 500 on an unexpected failure). |
| `routeOAuthClient(client, request, { basePath? })` | `@neon/oauth/adapter` | `Promise<Response \| undefined>` | `GET {basePath}/login`, `/callback`, `/logout`. `undefined` means "not mine, keep routing". |
| `routeMcpMetadata(auth, request)` | `@neon/oauth/mcp` | `Response \| undefined` | GET/OPTIONS on the RFC 9728 metadata paths (path-inserted and bare), with CORS. |

For MCP guards `@neon/oauth/mcp` also exports `MCP_METHODS` (`POST`, `GET`, `DELETE`) and `mcpPath(auth, path?)` (defaults to the path of `auth.resource`).

`basePath` is derived from the client's `redirectUri`: its path must end in `/callback`, and the rest is the prefix (`<origin>/api/auth/callback` serves `/api/auth/*`). An explicit `basePath` is only a check: `routeOAuthClient` and `resolveBasePath(client, opts)` throw, naming both values, if it disagrees. Call `resolveBasePath` when the adapter is created so a mismatch fails at startup, not on the first request.

## Template

An adapter imports `@neon/oauth/adapter` (sign-in and generic APIs) or `@neon/oauth/mcp` (MCP servers). Keep the two apart: importing only `@neon/oauth/mcp` keeps `openid-client` out of an MCP server's dependency graph.

```ts
// Type-only framework imports, so the framework stays an optional peer.
import type { MyCtx, MyMiddleware } from "myfw";
import { authenticate, resolveBasePath, routeOAuthClient } from "@neon/oauth/adapter";
import type { AuthSource, OAuthBearerOptions, OAuthClient } from "@neon/oauth/adapter";

const toRequest = (ctx: MyCtx): Request => /* ctx.rawRequest, or new Request(url, { method, headers }) */;

export function myBearerAuth(source: AuthSource, opts: OAuthBearerOptions): MyMiddleware {
  return async (ctx, next) => {
    const out = await authenticate(source, toRequest(ctx), opts);
    if (!out.ok) return ctx.send(out.response); // 1. failure: send the ready Response
    ctx.state.auth = out.auth; // 2. success: expose AuthResult where the framework keeps per-request data
    return next();
  };
}

export const myOAuthClient = (client: OAuthClient): MyMiddleware => {
  resolveBasePath(client); // fail at startup if redirectUri and basePath disagree
  return async (ctx, next) => {
    const res = await routeOAuthClient(client, toRequest(ctx));
    return res ? ctx.send(res) : next(); // undefined = fall through
  };
};
```

### MCP template

An MCP adapter serves the metadata routes, guards the MCP endpoint's methods, and exposes both the `AuthResult` and the MCP TypeScript SDK's `AuthInfo` (what tools receive as `extra.authInfo`). It uses the same primitives; only the source is the result of `createMcpAuth()` (an `McpAuth`).

```ts
import type { MyCtx, MyMiddleware } from "myfw";
import { authenticate } from "@neon/oauth/adapter";
import { MCP_METHODS, mcpPath, routeMcpMetadata } from "@neon/oauth/mcp";
import type { McpAuth } from "@neon/oauth/mcp";

const toRequest = (ctx: MyCtx): Request => /* as above */;

export function myMcp(auth: McpAuth): MyMiddleware {
  const target = mcpPath(auth); // the path of auth.resource
  return async (ctx, next) => {
    const request = toRequest(ctx);

    const metadata = routeMcpMetadata(auth, request); // 1. RFC 9728 metadata and its CORS preflight, unauthenticated
    if (metadata) return ctx.send(metadata);

    const { pathname } = new URL(request.url);
    if (pathname !== target || !(MCP_METHODS as readonly string[]).includes(request.method)) {
      return next(); // 2. not the MCP endpoint: keep routing
    }

    const out = await authenticate(auth, request); // 3. 401/403 challenges carry resource_metadata for MCP clients
    if (!out.ok) return ctx.send(out.response);
    ctx.state.auth = out.auth;
    ctx.state.authInfo = auth.toAuthInfo(out.auth); // 4. pass to transport.handleRequest(req, { authInfo })
    return next();
  };
}
```

Node-style `(req, res, next)` frameworks can build on `nodeMiddleware`, `nodeBearerAuth` and `nodeOAuthClient` from `@neon/oauth/node`, and `nodeMcp` from `@neon/oauth/mcp/node`. That is how the Express adapters are implemented in a few lines each.

## Checklist

1. Framework imports are `import type` only, and the framework is an optional peer dependency.
2. Use `authenticate`, `routeOAuthClient`, `resolveBasePath` and `routeMcpMetadata` for all auth and routing decisions: no `instanceof Response` checks, no challenges of your own. An MCP adapter also matches the endpoint itself, with `mcpPath` and `MCP_METHODS`, and converts the result with `auth.toAuthInfo`.
3. Forward every `Set-Cookie` separately (`response.headers.getSetCookie()`); `Headers` folds them otherwise.
4. Pass method, full URL (with query) and headers to the `Request`. Bodies are not needed by any contract function.
5. Never consume the request body in a guard: the MCP transport reads it afterwards (or takes the already-parsed body).
6. Smoke test it: 401 without a token, 200 with one, metadata, `/logout` redirect.

## Fetch-based runtimes (Bun, Deno, Workers)

No adapter needed. The core already takes a `Request` and returns a `Response`:

```ts
export default {
  async fetch(request: Request) {
    return routeMcpMetadata(auth, request) ?? (await app(request));
  },
};
```

`auth` is the result of `createMcpAuth()`, or `oauth.mcp()` on an existing instance. Add `routeOAuthClient(oauth.client, request)` only where Node APIs are available: the sign-in client uses `node:crypto`, so it does not run on Workers without Node compatibility.
