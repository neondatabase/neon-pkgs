# @neon/oauth

OAuth helpers for apps built on [Neon Auth](https://neon.com/docs/auth/overview) as an OAuth provider. Give it the Neon Auth URL (the OAuth issuer); it handles discovery, PKCE sign-in with encrypted session cookies, access-token verification for your APIs, and protecting [MCP](https://modelcontextprotocol.io) servers.

> **Beta.** The API may change in minor versions.

**`@neon/auth` or `@neon/oauth`?** [`@neon/auth`](../auth) is the SDK for apps that use Neon Auth for their own users (sessions, React, Next.js proxy). `@neon/oauth` is for apps that use Neon Auth as an OAuth provider: signing users in through the authorization-code flow, verifying the access tokens it issues, and protecting MCP servers. The packages are independent.

```bash
npm install @neon/oauth
```

Requires Node.js 20.19+. The sign-in client's cookie encryption uses `node:crypto`, so **it does not run on the Edge runtime** (including Next.js `runtime = "edge"`, and Cloudflare Workers without Node compatibility). Token verification (`@neon/oauth/verify`) and MCP protection (`@neon/oauth/mcp`) only need `jose` and `fetch`.

## Prerequisites

Set these up in Neon first. The [OAuth provider guide](https://neon.com/docs/auth/guides/plugins/oauth-provider) covers each step (the plugin is currently in private preview).

- **`NEON_AUTH_BASE_URL`:** the Auth URL of your branch, which is the OAuth issuer, e.g. `https://ep-example.neonauth.us-east-1.aws.neon.tech/neondb/auth`. Copy it from the Neon Console, or read `base_url` from `GET .../auth`. It differs on every branch.
- **A protected resource:** enable the OAuth provider on the branch (Console: **Settings** > **Better Auth** > **Plugins**) and add your API identifier (or MCP server URL) as a resource. It is an absolute URL that becomes the token's `aud`; it does not need to resolve. Use the same value as `resource` below.
- **`NEON_AUTH_CLIENT_ID` and `NEON_AUTH_CLIENT_SECRET`** (only to sign users in): create an OAuth client for your app, from the **OAuth clients** list in the OAuth provider settings or the create-client API. A confidential client shows its secret once; a public client has none. For MCP and other public clients, a [Client ID Metadata Document](#client-id-metadata-documents) replaces this step.
- **The redirect URI:** register `https://app.example.com/api/auth/callback` on the client. It must match exactly, use `https` (or `http` on a loopback host when localhost access is enabled for the branch), and contain no fragment or credentials.
- **`NEON_AUTH_COOKIE_SECRET`:** 32+ random characters, e.g. `openssl rand -hex 32`.

You also host the login and consent pages the authorization server redirects to; the guide explains how they complete the flow.

## Quickstart

A complete Hono app that signs users in with cookies and protects an API with bearer tokens (the values come from [Prerequisites](#prerequisites)). Other frameworks and setups are covered below.

```ts
import { Hono } from "hono";
import { createOAuth } from "@neon/oauth";
import { honoBearerAuth, honoOAuthClient, type AuthVariables } from "@neon/oauth/hono";

const oauth = createOAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  resource: "https://api.example.com",
  clientId: process.env.NEON_AUTH_CLIENT_ID!,
  redirectUri: "https://app.example.com/api/auth/callback",
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
});

const app = new Hono<AuthVariables>();
app.use(honoOAuthClient(oauth.client)); // GET /api/auth/login, /callback, /logout
app.get("/me", async (c) => {
  const result = await oauth.client.getUser(c.req.raw);
  return result.ok ? c.json(result.user) : c.json({ error: result.reason }, 401);
});
app.get("/api/things", honoBearerAuth(oauth), (c) => c.json({ user: c.get("auth").sub }));

export default app;
```

Open `/api/auth/login?returnTo=/me` to sign in. See [Sign in](#sign-in), [Protect an API](#protect-an-api) and [Protect an MCP server](#protect-an-mcp-server) for the rest.

## Contents

- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Choose your setup](#choose-your-setup)
- [Sign users in and protect an API](#sign-users-in-and-protect-an-api)
  - [Sign in](#sign-in)
  - [Call an API as the user](#call-an-api-as-the-user)
  - [Protect an API](#protect-an-api)
- [Protect an API without signing users in](#protect-an-api-without-signing-users-in)
- [Protect an MCP server](#protect-an-mcp-server)
- [Client ID Metadata Documents (recommended for MCP / public clients)](#client-id-metadata-documents-recommended-for-mcp--public-clients)
- [Framework adapters](#framework-adapters)
- [Errors and results](#errors-and-results)
- [Neon Auth notes](#neon-auth-notes)
- [Develop](#develop)
- [Appendix: entry points](#appendix-entry-points)

## Choose your setup

| You are building... | Start with | Import from |
|---|---|---|
| An app that **signs users in** | `createOAuth()` | `@neon/oauth` |
| An **API that accepts tokens** and never signs anyone in | `createVerifier()` (works with every framework guard, see [Protect an API without signing users in](#protect-an-api-without-signing-users-in)) | `@neon/oauth/verify` |
| Authentication for an **MCP server** | `createMcpAuth()` | `@neon/oauth/mcp` |
| **Several** of the above in one app | one `createOAuth()` instance; its `client`, `requireBearerAuth()` and `mcp()` share discovery and key caches | `@neon/oauth` |

API-only and MCP-only servers import the specialized entry points, which depend on [`jose`](https://github.com/panva/jose) alone and never load `openid-client`.

## Sign users in and protect an API

`createOAuth` is one factory for one issuer. Configuration is explicit: nothing is read from the environment.

```ts
import { createOAuth } from "@neon/oauth";

export const oauth = createOAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!, // the OAuth issuer, e.g. https://ep-x.neonauth.../neondb/auth
  resource: "https://api.example.com", // your API; becomes the token's `aud`
  // Only for signing users in (adds `oauth.client`):
  clientId: process.env.NEON_AUTH_CLIENT_ID!,
  clientSecret: process.env.NEON_AUTH_CLIENT_SECRET, // omit for a public client
  redirectUri: "https://app.example.com/api/auth/callback", // registered on the client; must end in /callback
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! }, // 32+ chars: openssl rand -hex 32
});
```

`oauth.client` exists only when `clientId`, `redirectUri` and `cookies` are all provided; a partial set throws from `createOAuth`, naming what is missing. API-only apps pass just `baseUrl` (and `resource`).

| Option | Notes |
|---|---|
| `baseUrl` | Required, absolute URL. |
| `resource` | The API's identifier. `requireBearerAuth()` verifies against it unless you pass an `audience`. Also accepted by `createVerifier`. |
| `cookies` | `{ secret, name = "neon_auth_session", maxAgeSeconds = 7d, domain, sameSite = "lax" }`. `sameSite` and `domain` apply to the session cookie; the short-lived login cookie is always Lax. |
| `scopes` | Default `["profile", "email"]`; `openid` is always requested (added if omitted) because sign-in needs the ID token. |
| `algorithms`, `clockTolerance` | Token verification. Algorithms default to `["EdDSA"]`. |
| `discovery` | `{ ttlMs = 1h, failureBackoffMs = 5s }`. |
| `jwks` | Passed to jose's `createRemoteJWKSet`. |

### Sign in

The sign-in routes are `GET <prefix>/login` (`?returnTo=/path`), `<prefix>/callback` and `<prefix>/logout`. `<prefix>` is taken from `redirectUri`'s path (`https://app.example.com/api/auth/callback` serves `/api/auth/*`), so the callback route and the registered redirect cannot drift apart. An explicit `basePath` option that disagrees with `redirectUri` throws, naming both.

```ts
const { client } = oauth;

app.use(honoOAuthClient(client)); // @neon/oauth/hono
app.use(expressOAuthClient(client)); // @neon/oauth/express
export const { GET } = createRouteHandlers(client); // @neon/oauth/next, app/api/auth/[...oauth]/route.ts
// Any other: (await routeOAuthClient(client, request)) ?? next()

const result = await client.getUser(request);
if (result.ok) result.user; // { id, email?, emailVerified?, name?, image? }; `id` is the ID token `sub`
else result.reason; // "no_session" | "invalid_session" | "expired"
```

For plain `node:http`, `nodeOAuthClient` is a `(req, res, next)` middleware:

```ts
import { createServer } from "node:http";
import { nodeOAuthClient } from "@neon/oauth/node";

const signIn = nodeOAuthClient(oauth.client);
createServer((req, res) =>
  signIn(req, res, (err) => {
    // `err` is set when the middleware failed (for example a misconfiguration): answer 500, not 404.
    res.statusCode = err ? 500 : 404; // not a sign-in route: continue with your own routing
    res.end();
  }),
).listen(3000);
```

Express and `node:http` hand your handlers their own request type, but `getUser`, `getSession`, `getAccessToken` and `withAccessToken` take a Web `Request`. Build one from the URL and the `Cookie` header. With `getAccessToken`, a refreshed session comes back as `setCookie`, which you append to your own response:

```ts
import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from "express";
import { AuthServerUnavailableError, type OAuthClient } from "@neon/oauth";

const toRequest = (req: ExpressRequest) =>
  new Request(`${req.protocol}://${req.get("host")}${req.originalUrl}`, {
    headers: { cookie: req.headers.cookie ?? "" },
  });

// Express 4 does not catch rejected promises: handle errors and pass the rest to next().
export async function things(client: OAuthClient, req: ExpressRequest, res: ExpressResponse, next: NextFunction) {
  try {
    const token = await client.getAccessToken(toRequest(req));
    if (!token.ok) return res.redirect("/api/auth/login");
    if (token.setCookie) res.append("set-cookie", token.setCookie);
    const upstream = await fetch("https://api.example.com/things", {
      headers: { authorization: `Bearer ${token.accessToken}` },
    });
    res
      .status(upstream.status)
      .type(upstream.headers.get("content-type") ?? "application/octet-stream")
      .send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    if (err instanceof AuthServerUnavailableError) return res.status(503).set("Retry-After", "5").end();
    next(err);
  }
}
```

With `node:http`, build the request and send the cookie like this:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";

const toRequest = (req: IncomingMessage) =>
  new Request(new URL(req.url ?? "/", "https://app.example.com"), {
    headers: { cookie: req.headers.cookie ?? "" },
  });

const setSessionCookie = (res: ServerResponse, setCookie: string) => res.setHeader("set-cookie", setCookie);
```

### Call an API as the user

`withAccessToken` loads (and if needed refreshes) the user's access token, runs your callback, and appends the refreshed session cookie to the `Response` you return:

```ts
import { AuthServerUnavailableError } from "@neon/oauth";

async function things(request: Request): Promise<Response> {
  try {
    const out = await client.withAccessToken(request, ({ authorizationHeaders }) =>
      fetch("https://api.example.com/things", { headers: authorizationHeaders }),
    );
    if (out.ok) return out.response;
    // no_session | refresh_unavailable | refresh_failed: this user has to sign in again.
    return Response.redirect(new URL("/api/auth/login", request.url));
  } catch (err) {
    if (err instanceof AuthServerUnavailableError) {
      // Neon Auth could not be reached to refresh the token. The user is still signed in:
      // do not send them to login, ask them to retry.
      return new Response("Sign-in service unavailable, try again shortly.", {
        status: 503,
        headers: { "Retry-After": "5" },
      });
    }
    throw err;
  }
}
```

Only `{ ok: false }` means the session cannot be used. An unreachable authorization server is thrown as `AuthServerUnavailableError` (see [Errors and results](#errors-and-results)), so an outage never looks like a sign-out.

`client.getAccessToken(request)` is the lower-level form. It returns `{ ok: true, accessToken, setCookie? } | { ok: false, reason }`; if `setCookie` is present the token was refreshed and you must append it to your response as `Set-Cookie`. Concurrent refreshes of one refresh token within a process share a single token request. Separate processes do not coordinate.

`client.startLogin()` and `client.finishLogin()` are for custom sign-in flows. Most apps use `handlers` through an adapter.

### Protect an API

```ts
// The audience defaults to `resource` from createOAuth; pass `{ audience }` to override it.

// Hono
app.get("/api/things", honoBearerAuth(oauth, { requiredScopes: ["read"] }), (c) => c.json({ user: c.get("auth").sub }));

// Express
app.get("/api/things", expressBearerAuth(oauth), (req, res) => res.json({ user: (req as AuthedRequest).auth.sub }));

// Next.js App Router (app/api/things/route.ts)
export const GET = withAuth(oauth, (req, auth) => Response.json({ user: auth.sub }));

// node:http: nodeBearerAuth(oauth) is a (req, res, next) middleware that sets req.auth

// Anything else
const out = await authenticate(oauth, request); // from "@neon/oauth/adapter"
if (!out.ok) return out.response; // 401/403 with an RFC 6750 WWW-Authenticate, 503 if Neon Auth is unavailable, 500 on an unexpected failure
out.auth; // { token, sub, clientId?, scopes, audience, expiresAt, claims }
```

A token without a `sub` claim is rejected (code `missing_sub`); `clientId` is `undefined` when the token has no `client_id`.

Lower level: `oauth.requireBearerAuth()(request)` or `oauth.verifyAccessToken(token, { audience })`, which returns `{ ok: true, auth } | { ok: false, reason: "invalid_token", code, message }`. The challenge has no `resource_metadata` by default; pass `resourceMetadataUrl: true` (derive from the audience) or a URL.

## Protect an API without signing users in

An API that only accepts tokens uses `createVerifier` from `@neon/oauth/verify`, which depends on `jose` alone and never loads `openid-client`. Every guard above (`honoBearerAuth`, `expressBearerAuth`, `nodeBearerAuth`, `withAuth`, `authenticate`) takes a verifier in place of `oauth`:

```ts
import { Hono } from "hono";
import { honoBearerAuth } from "@neon/oauth/hono";
import { createVerifier } from "@neon/oauth/verify";

const verifier = createVerifier({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  resource: "https://api.example.com", // the audience tokens must carry
});

const app = new Hono();
app.get("/api/things", honoBearerAuth(verifier, { requiredScopes: ["read"] }), (c) =>
  c.json({ user: c.get("auth").sub }),
);
```

`verifier.requireBearerAuth()` and `verifier.verifyAccessToken(token, audience)` are the lower-level forms. MCP servers use `createMcpAuth` instead, since they also serve the protected-resource metadata.

## Protect an MCP server

`createMcpAuth()` does not create an MCP server. It creates the authentication helper for the MCP server you already have (for example one built with `@modelcontextprotocol/sdk`): token verification bound to the MCP endpoint URL, plus the protected-resource metadata MCP clients use to find the authorization server. An adapter such as `honoMcp` is the middleware that serves that metadata and guards the MCP endpoint with it.

```ts
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpAuth } from "@neon/oauth/mcp";
import { honoMcp, type McpAuthVariables } from "@neon/oauth/mcp/hono";

const auth = createMcpAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  resource: "https://mcp.example.com/mcp", // the MCP endpoint URL; becomes the token's `aud`
});
// A stateless transport serves one request, so build the server and transport per request.
const newServer = () => new McpServer({ name: "demo", version: "1.0.0" });

const app = new Hono<McpAuthVariables>();
// Serves /.well-known/oauth-protected-resource/mcp (+ bare fallback, CORS) and guards POST/GET/DELETE /mcp.
app.use(honoMcp(auth));
app.all("/mcp", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await newServer().connect(transport);
  return transport.handleRequest(c.req.raw, { authInfo: c.get("authInfo") });
});
```

The Web-standard transport (`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, used by the Hono and Next.js examples) needs `@modelcontextprotocol/sdk` 1.25.0 or later. The Node `StreamableHTTPServerTransport` used by the Express and `node:http` adapters is older.

`resource` is the audience. 401/403 challenges include `resource_metadata` pointing at the path-inserted RFC 9728 metadata URL. `scopesSupported` adds `scopes_supported` to the metadata document. Verification options (`algorithms`, `clockTolerance`, `discovery`, `jwks`) are accepted alongside.

In handlers, `c.get("auth")` is the verified `AuthResult` and `c.get("authInfo")` the same result as the MCP TypeScript SDK's `AuthInfo` (from `@modelcontextprotocol/sdk/server/auth/types.js`). Pass it to `transport.handleRequest(req, { authInfo })` and your tool handlers receive it as `extra.authInfo`, which is how a tool learns who is calling and with which scopes. Typing the app as `new Hono<McpAuthVariables>()` is what exposes them; alternatively use `honoMcpBearerAuth(auth)` as route middleware (`app.post("/mcp", honoMcpBearerAuth(auth), handler)`), which types the handler on its own.

Express: `app.use(expressMcp(auth))`; the guard reads headers only, so it works before or after `express.json()`. `req.auth` is an `AuthResult` until you replace it: the SDK's Node transport reads `req.auth` as its `AuthInfo` (the same type, delivered to tools as `extra.authInfo`), so convert it before `handleRequest`.

```ts
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpAuth } from "@neon/oauth/mcp";
import { expressMcp, type AuthedRequest } from "@neon/oauth/mcp/express";

const auth = createMcpAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  resource: "https://mcp.example.com/mcp",
});
const newServer = () => new McpServer({ name: "demo", version: "1.0.0" });

const app = express();
app.use(expressMcp(auth));
app.use(express.json());
app.post("/mcp", async (req, res) => {
  const result = (req as AuthedRequest).auth; // AuthResult
  Object.assign(req, { auth: auth.toAuthInfo(result) }); // from here `req.auth` is the SDK's AuthInfo
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await newServer().connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

Next.js App Router:

Create `auth` once in a shared module so both routes use the same instance:

```ts
// lib/mcp-auth.ts
import { createMcpAuth } from "@neon/oauth/mcp";

export const auth = createMcpAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  resource: "https://mcp.example.com/mcp",
});

// app/.well-known/oauth-protected-resource/[[...path]]/route.ts
import { createMetadataHandlers } from "@neon/oauth/mcp/next";
import { auth } from "@/lib/mcp-auth";

export const { GET, OPTIONS } = createMetadataHandlers(auth);

// app/mcp/route.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { withMcpAuth } from "@neon/oauth/mcp/next";
import { auth } from "@/lib/mcp-auth";

const newServer = () => new McpServer({ name: "demo", version: "1.0.0" });

export const POST = withMcpAuth(auth, async (request, result) => {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await newServer().connect(transport);
  return transport.handleRequest(request, { authInfo: auth.toAuthInfo(result) });
});
```

`createMcpAuth(opts)` is `createOAuth({ baseUrl, ... }).mcp({ resource, scopesSupported })` without the sign-in client. If the same app also signs users in or guards other APIs, call `oauth.mcp({ resource })` on your existing `oauth` instead so everything shares one discovery cache.

## Client ID Metadata Documents (recommended for MCP / public clients)

Instead of pre-registering a client, make your `clientId` an https URL that serves a small JSON document describing the client. The authorization server fetches that document itself when it sees the URL; your app never fetches anything. There is no registration step and no secret.

```ts
import { createClientMetadataDocument, createOAuth } from "@neon/oauth";

const clientId = "https://app.example.com/oauth/client.json";

export const metadata = createClientMetadataDocument({
  clientId, // the URL this document is served from
  clientName: "Reports",
  redirectUris: ["https://app.example.com/api/auth/callback"],
});

export const oauth = createOAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  clientId, // a URL, sent as-is
  redirectUri: "https://app.example.com/api/auth/callback",
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
});
```

Serve the document at the `clientId` URL with the adapter for your framework. It answers `GET`/`HEAD` with `application/json` and `Cache-Control: public, max-age=3600`.

```ts
app.use(honoClientMetadata(metadata)); // @neon/oauth/hono
app.use(expressClientMetadata(metadata)); // @neon/oauth/express
nodeClientMetadata(metadata)(req, res, next); // @neon/oauth/node
// app/oauth/client.json/route.ts: @neon/oauth/next
export const { GET } = createClientMetadataHandlers(metadata);
```

The document sets `client_id` to its own URL, `token_endpoint_auth_method: "none"` (public client, PKCE), `response_types: ["code"]` and `grant_types` (default `authorization_code` and `refresh_token`), plus optional `client_uri`, `logo_uri` and `scope`. `createClientMetadataDocument` throws `OAuthConfigError` for a `clientId` that is not an https URL with a path (no fragment or credentials), for a non-loopback `http` redirect URI, and for an empty `clientName` or `redirectUris`.

- **The authorization server must support it.** Neon Auth advertises `client_id_metadata_document_supported` in its discovery document. With a URL `clientId` against a server that does not, `startLogin`, `finishLogin` or a token refresh (and so the `login` route) throws an `OAuthConfigError` naming the issuer, rather than sending a `client_id` the server will reject.
- **The URL must be publicly reachable over https** by the authorization server, so local development needs a tunnel. Redirect URIs may still be `http://localhost`.
- **Public clients only.** Passing `clientSecret` with a URL `clientId` throws.
- **MCP clients** that do not ship a document of their own should use this instead of Dynamic Client Registration, which the MCP specification deprecates.

## Framework adapters

| Framework | Sign-in and API guards | MCP |
|---|---|---|
| Hono | `@neon/oauth/hono` | `@neon/oauth/mcp/hono` |
| Express | `@neon/oauth/express` | `@neon/oauth/mcp/express` |
| Next.js (App Router) | `@neon/oauth/next` | `@neon/oauth/mcp/next` |
| `node:http` | `@neon/oauth/node` | `@neon/oauth/mcp/node` |

The Next.js adapter covers **route handlers only** (`createRouteHandlers`, `withAuth`, `withMcpAuth`). Reading the session in Server Components, Server Actions or middleware is not provided yet; call `client.getUser(request)` / `client.getSession(request)` yourself where you have a `Request`.

`hono`, `express` and `@modelcontextprotocol/sdk` are optional peer dependencies, imported for types only. Install the ones you use. Next.js needs no peer: the adapters are plain `Request`/`Response` functions. For a framework not listed, see [docs/ADAPTERS.md](docs/ADAPTERS.md).

## Errors and results

Each layer follows one rule:

| Situation | What you get | Examples |
|---|---|---|
| **Misconfiguration** (a programmer error) | `OAuthConfigError`, thrown when you create the object (except a URL `clientId` against a server without CIMD support, known only after discovery, which `startLogin`, `finishLogin` or a token refresh throws; and the bearer-guard case below) | `createOAuth()` with a missing `baseUrl`, a partial client config or a short `cookies.secret`; `requireBearerAuth()` without an audience; a `redirectUri` that does not end in `/callback` |
| **Authorization server unreachable** (discovery, JWKS, token and userinfo endpoints: network, timeout, 5xx, untrusted document) | `AuthServerUnavailableError`, thrown by every operation that needs the server. It is never reported as "signed out" | `getDiscovery`, `verifyAccessToken`, `startLogin`, `finishLogin`, `getAccessToken` / `withAccessToken` when a refresh is needed |
| **Expected auth outcome** | a returned `{ ok: false, reason }` | see below |

`OAuthError` is the base class of `OAuthConfigError`, `AuthServerUnavailableError` and `InvalidTokenError`.

| Operation | `reason` when `ok` is false |
|---|---|
| `getSession()` / `getUser()` | `no_session`, `invalid_session` (tampered cookie or rotated secret), `expired` |
| `getAccessToken()` / `withAccessToken()` | `no_session`, `refresh_unavailable`, `refresh_failed` (the server rejected the refresh token) |
| `verifyAccessToken()` | `invalid_token`, with `code`: `expired`, `invalid_audience`, `invalid_issuer`, `missing_sub` or `invalid_token` |
| `finishLogin()` | `invalid_callback` (error, missing code or forged `state`), `token_rejected` (code refused, or no ID token), `userinfo_rejected` (userinfo answered 4xx or with an unusable body, or its `sub` differs from the ID token's) |

`refresh_failed` means the server answered and rejected the refresh token, so the user must sign in again. An outage is never reported as `refresh_failed` or `no_session`; it is thrown as `AuthServerUnavailableError`, and the right response is a retry message (503), not a login redirect.

The HTTP helpers answer instead of throwing:

- **Bearer guards and every bearer adapter** reply `401` (invalid or missing token, with `WWW-Authenticate`), `403` (insufficient scope), `503` (server unavailable) or `500` (unexpected failure). The one exception is a guard with no `audience` and no configured `resource`, which is an `OAuthConfigError`: `requireBearerAuth()` throws it once, when the guard is created; the framework guards and `authenticate` build theirs per request, so every request fails (via `next(err)`, the framework's error handler, or a rejected promise).
- **Sign-in routes** reply `302` on success, `400` for a bad callback (including `token_rejected` / `userinfo_rejected`), `503` when the server is unavailable and `500` for an unexpected failure. Sign-in needs the userinfo endpoint: if it is unreachable the callback answers `503` and sets no session cookie.
- **Logging:** pass `onError(error, request)` to `createOAuth` (sign-in routes) or to the guard's options (`requireBearerAuth`, `honoBearerAuth`, `honoMcp`, ...) to log the underlying cause of a 5xx. Nothing is logged by default.

## Neon Auth notes

- **`resource` becomes `aud`.** The client sends `resource=<audience>` on authorize and token requests; the API must verify the same string. A mismatch rejects every call.
- **`iss` is per branch, keys are shared across branches.** The signature alone does not prove the branch, so `iss` is matched exactly, and discovery's `issuer` must equal the configured one.
- **`client_secret_basic` only.** Neon Auth rejects `client_secret_post` for confidential clients. Public clients use PKCE with no secret.
- **Profile comes from userinfo, and sign-in requires it.** The ID token has no name/email, so the client calls the userinfo endpoint at sign-in and stores the result in the session. `user.id` is always the verified ID token `sub`. Userinfo returns `email` / `emailVerified` for the `email` scope and `name` / `image` for the `profile` scope, so those four fields are optional on `AuthUser` and absent (never `""`) when not returned.
- **Tokens are EdDSA.** `algorithms` defaults to `["EdDSA"]` for access tokens, and the sign-in client expects an EdDSA-signed ID token.
- **The session lives in the cookie.** AES-256-GCM (`dir`) JWE, key derived with HKDF-SHA-256 from `cookies.secret`; HttpOnly, SameSite=Lax by default (`cookies.sameSite`), `Secure` unless the redirect URI is `http://localhost`. A warning is logged if it passes ~3.8 KB. Rotating `cookies.secret` signs everyone out.
- **Logout is local.** It clears this app's cookie; it does not end the Neon Auth session.

## Develop

```bash
pnpm --filter @neon/oauth test:ci
pnpm --filter @neon/oauth build
```

Tests run a real local HTTP server as a fake Neon Auth, so they exercise the same `fetch` and JWKS code paths as production.

## Appendix: entry points

A test bundles each jose-only entry and fails if it pulls in `openid-client` or the sign-in client.

| Import | Provides | Loads `openid-client` |
|---|---|---|
| `@neon/oauth` | `createOAuth`, `createClientMetadataDocument`: verification, MCP servers and the sign-in client from one issuer | yes |
| `@neon/oauth/verify` | `createVerifier`, `createBearerGuard`, `OAuthError`, `OAuthConfigError`, `AuthServerUnavailableError`, `InvalidTokenError`, `AuthResult`, `VerifyResult` | no |
| `@neon/oauth/mcp` | `createMcpAuth`, `toAuthInfo`, `routeMcpMetadata`, `MCP_METHODS`, `mcpPath`, `McpAuth`, errors | no |
| `@neon/oauth/mcp/hono` | `honoMcp`, `honoMcpBearerAuth`, `honoProtectedResourceMetadata`, `McpAuthVariables` | no |
| `@neon/oauth/mcp/express` | `expressMcp`, `expressMcpBearerAuth` (`req.auth`) | no |
| `@neon/oauth/mcp/next` | `withMcpAuth`, `createMetadataHandlers` | no |
| `@neon/oauth/mcp/node` | `nodeMcp`, `nodeMcpBearerAuth` | no |
| `@neon/oauth/hono` | `honoBearerAuth`, `honoOAuthClient`, `honoClientMetadata`, `AuthVariables` | no (types only) |
| `@neon/oauth/express` | `expressBearerAuth`, `expressOAuthClient`, `expressClientMetadata` | no (types only) |
| `@neon/oauth/next` | `withAuth`, `createRouteHandlers`, `createClientMetadataHandlers` | no (types only) |
| `@neon/oauth/node` | `toNodeHandler`, `nodeBearerAuth`, `nodeOAuthClient`, `nodeClientMetadata`, `nodeMiddleware` | no (types only) |
| `@neon/oauth/adapter` | The adapter contract: `authenticate`, `routeOAuthClient`, `routeClientMetadata`, `clientMetadataResponse` | no |
