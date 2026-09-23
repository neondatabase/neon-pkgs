# Building a Neon Auth framework adapter

This guide shows how to build a `@neon/auth` adapter for a server
framework that doesn't ship with `neon-js`. The bundled `@neon/auth/next`
adapter is the reference implementation; this document walks through the parts
of it that map directly to anything you'd do for Hono, Remix, SolidStart,
Express, Fastify, etc.

> **Stability: beta.** The toolkit lives at the `@neon/auth/server`
> subpath. Minor versions of `@neon/auth` may include breaking changes
> to this surface, with migration notes in the package CHANGELOG. Pin your
> peer dependency to a narrow range.

## The three pieces every adapter ships

1. A **server factory** that returns a typed proxy of Better Auth server
   methods (`createNeonAuth` in the Next.js adapter).
2. An **API route handler** mounted at `/api/auth/*` that proxies upstream
   (`auth.handler()` in the Next.js adapter).
3. A **middleware** that protects routes and finalizes OAuth callbacks
   (`auth.middleware()` in the Next.js adapter).

Everything else — session caching, cookie minting, JWT validation, OAuth
token exchange, network error classification — is implemented inside the
toolkit and reused by every adapter.

## Architecture in one diagram

```text
your-adapter/
├── adapter.ts         RequestContext: framework -> toolkit bridge
├── handler.ts         /api/auth/* route mount (calls handleAuthProxyRequest)
├── middleware.ts      route protection (calls processAuthMiddleware)
└── index.ts           createYourAdapter: wires the above 3 + createAuthServer
```

All four files import only from `@neon/auth/server` and your
framework's request/response APIs.

## Step 1 — Implement `RequestContext`

`RequestContext` is the contract between the toolkit and your framework. It
abstracts away how your framework exposes the in-flight request's cookies,
headers, and origin. Implementations are framework-specific but always
shaped the same way:

```typescript
// adapter.ts
import type { RequestContext } from '@neon/auth/server';
import { extractNeonAuthCookies, serializeSetCookie } from '@neon/auth/server';
import { getContext } from 'hono/context-storage'; // example: Hono

function createHonoRequestContext(): RequestContext {
  const c = getContext();
  return {
    getCookies: () => extractNeonAuthCookies(c.req.header('cookie') ?? ''),
    setCookie: (name, value, options) => {
      // `serializeSetCookie` takes a single `ParsedCookie` object — the toolkit's
      // canonical Set-Cookie serializer. Pass the toolkit's `options` through
      // verbatim; it already sanitizes flags before reaching your adapter.
      c.header('Set-Cookie', serializeSetCookie({ name, value, ...options }), {
        append: true,
      });
    },
    getHeader: (name) => c.req.header(name) ?? null,
    getOrigin: () => c.req.header('origin') ?? '',
    getFramework: () => 'hono',
  };
}
```

See the [`RequestContext` JSDoc](./src/server/request-context.ts) for the full
contract — every method's input, output, and "MAY throw / MUST NOT throw"
semantics are documented inline.

## Step 2 — Build the server factory

Compose `createAuthServer` with your `RequestContext` factory and the framework
adapter's own surface (handler + middleware):

```typescript
// index.ts
import {
  createAuthServer,
  validateCookieConfig,
  resolveNeonAuthLogging,
  type NeonAuthConfig,
} from '@neon/auth/server';
import { authHandler } from './handler';
import { authMiddleware } from './middleware';

export function createHonoAuth(config: NeonAuthConfig) {
  validateCookieConfig(config.cookies);
  const log = resolveNeonAuthLogging(config);

  // `createAuthServer` takes a FLAT config: the nested `cookies` block from
  // your adapter's public `NeonAuthConfig` is mapped to top-level fields.
  // Do NOT spread `...config.cookies` — that yields `{ secret, ... }` while
  // the toolkit reads `cookieSecret`, so the spread silently produces an
  // invalid shape and `cookieSecret` is `undefined` at runtime.
  const server = createAuthServer({
    baseUrl: config.baseUrl,
    context: createHonoRequestContext,
    cookieSecret: config.cookies.secret,
    sessionDataTtl: config.cookies.sessionDataTtl,
    domain: config.cookies.domain,
    sameSite: config.cookies.sameSite,
    log,
  });

  // Single flat config used by both the route handler (Step 3) and the
  // middleware (Step 4). They each read FLAT fields (`cookieSecret`,
  // `sessionDataTtl`, `domain`, `sameSite`, `log`) and would also break on
  // `...config.cookies`.
  const proxyConfig = {
    baseUrl: config.baseUrl,
    cookieSecret: config.cookies.secret,
    sessionDataTtl: config.cookies.sessionDataTtl,
    domain: config.cookies.domain,
    sameSite: config.cookies.sameSite,
    log,
  };

  // Attach the route handler + middleware so apps get one cohesive surface.
  Object.assign(server, {
    handler: () => authHandler(proxyConfig),
    middleware: (opts: { loginUrl: string }) =>
      authMiddleware({ ...proxyConfig, ...opts }),
  });

  return server as typeof server & {
    handler: typeof authHandler;
    middleware: typeof authMiddleware;
  };
}
```

## Step 3 — Mount the proxy handler

The toolkit's `handleAuthProxyRequest` takes a single `AuthProxyConfig` object
and returns a `Promise<Response>`. `path` is the slash-joined remainder after
your `/api/auth/` mount point (e.g. `'sign-in/email'`), not an array. Mount it
under the conventional `/api/auth/*` path:

```typescript
// handler.ts
import { handleAuthProxyRequest } from '@neon/auth/server';

export function authHandler(config: ProxyConfig) {
  return async (c: Context) => {
    const path = c.req.path.replace(/^\/api\/auth\//, '');
    return handleAuthProxyRequest({
      request: c.req.raw,
      path,
      baseUrl: config.baseUrl,
      cookieSecret: config.cookieSecret,
      sessionDataTtl: config.sessionDataTtl,
      domain: config.domain,
      sameSite: config.sameSite,
      log: config.log,
    });
  };
}
```

The toolkit handles upstream URL composition, header forwarding, cookie
sanitization, session-data cookie minting, and network error classification
internally. Your handler is intentionally a one-liner.

## Step 4 — Add middleware

`processAuthMiddleware` returns a discriminated `MiddlewareResult` describing
what should happen to the response. The discriminant is `action` (not `type`)
and has **three** variants — handle all three or the OAuth callback path will
silently break:

| `action` | `redirectUrl` | `cookies` | `headers` | When |
|---|---|---|---|---|
| `'allow'` | — | optional | optional | Public route, or session valid (session-data cookie may need refresh) |
| `'redirect_oauth'` | `URL` (required) | required | — | `?code=` callback after OAuth — verifier exchanged, cookies cleared, redirect onward |
| `'redirect_login'` | `URL` (required) | optional | — | Protected route, no/expired session |

Translate each variant into your framework's native response/redirect API:

```typescript
// middleware.ts
import { processAuthMiddleware, DEFAULT_AUTH_SKIP_ROUTES } from '@neon/auth/server';

export function authMiddleware(config: MiddlewareConfig) {
  return async (c: Context, next: Next) => {
    const url = new URL(c.req.url);
    const result = await processAuthMiddleware({
      request: c.req.raw,
      pathname: url.pathname,
      skipRoutes: DEFAULT_AUTH_SKIP_ROUTES,
      loginUrl: config.loginUrl,
      baseUrl: config.baseUrl,
      cookieSecret: config.cookieSecret,
      sessionDataTtl: config.sessionDataTtl,
      domain: config.domain,
      sameSite: config.sameSite,
      log: config.log,
    });

    switch (result.action) {
      case 'allow':
        // Forward any signal headers (e.g. `x-neon-auth-middleware: true`) so
        // downstream handlers know auth middleware already ran.
        if (result.headers) {
          for (const [k, v] of Object.entries(result.headers)) c.req.raw.headers.set(k, v);
        }
        await next();
        if (result.cookies) {
          for (const cookie of result.cookies) c.header('Set-Cookie', cookie, { append: true });
        }
        return;

      case 'redirect_oauth':
        // Verifier-cleanup cookies MUST be set on the redirect response.
        for (const cookie of result.cookies) c.header('Set-Cookie', cookie, { append: true });
        return c.redirect(result.redirectUrl.toString(), 302);

      case 'redirect_login':
        if (result.cookies) {
          for (const cookie of result.cookies) c.header('Set-Cookie', cookie, { append: true });
        }
        return c.redirect(result.redirectUrl.toString(), 302);
    }
  };
}
```

`DEFAULT_AUTH_SKIP_ROUTES` matches what the Next.js adapter uses; you can
compose it with your own public routes (`[...DEFAULT_AUTH_SKIP_ROUTES, '/healthz']`).

## Node-style (non-Fetch) frameworks (Express, Fastify)

Express and Fastify do not natively expose Fetch `Request` / `Response`
objects. The toolkit only speaks Fetch, so an adapter has to bridge in two
places: the request entering `handleAuthProxyRequest` and the response coming
back out. Six gotchas show up in practice — handle them all and the rest of
the adapter looks just like the Fetch-native walkthrough above.

### 1. Build a Fetch `Request` from a Node `IncomingMessage`

You need an **absolute** URL (Node `req.url` is path-only) and you must mark
the body as half-duplex when there is one, otherwise the `Request`
constructor throws on Node ≥ 18.

```typescript
function toFetchRequest(req: import('node:http').IncomingMessage, body?: Buffer): Request {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `${proto}://${host}`);

  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: req.headers as Record<string, string>,
  };
  if (body && body.length > 0) {
    init.body = body;
    init.duplex = 'half'; // required by undici when body is set
  }
  return new Request(url, init);
}
```

### 2. Write `Response` back — preserve **multiple** `Set-Cookie` headers

**Critical.** `response.headers.get('set-cookie')` comma-merges multiple
cookies and corrupts any cookie with `Expires=Wed, 01 Jan 1970…` (the comma
inside the date is interpreted as a separator). Always use the array form:

```typescript
// Express
async function writeFetchResponse(res: import('express').Response, fetchRes: Response) {
  res.status(fetchRes.status);
  for (const [k, v] of fetchRes.headers) {
    if (k.toLowerCase() === 'set-cookie') continue;
    res.setHeader(k, v);
  }
  res.setHeader('set-cookie', fetchRes.headers.getSetCookie()); // <-- array
  res.send(Buffer.from(await fetchRes.arrayBuffer()));
}

// Fastify (use reply.raw to set multiple Set-Cookie cleanly)
async function writeFetchReply(reply: import('fastify').FastifyReply, fetchRes: Response) {
  reply.raw.statusCode = fetchRes.status;
  for (const [k, v] of fetchRes.headers) {
    if (k.toLowerCase() === 'set-cookie') continue;
    reply.raw.setHeader(k, v);
  }
  reply.raw.setHeader('set-cookie', fetchRes.headers.getSetCookie());
  reply.raw.end(Buffer.from(await fetchRes.arrayBuffer()));
}
```

### 3. Raw body parsing on the auth route

The toolkit forwards the body verbatim to upstream; pre-parsed JSON ruins
upstream signature verification. Disable framework body parsers on the auth
mount only:

```typescript
// Express 5
import express from 'express';
app.use('/api/auth', express.raw({ type: '*/*' }));

// Fastify
fastify.removeAllContentTypeParsers();
fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) =>
  done(null, body)
);
```

### 4. Express 5 wildcard syntax

Express 5 ships path-to-regexp v8, which requires a **named** wildcard. The
bare `/api/auth/*` form throws at registration time:

```typescript
app.all('/api/auth/*splat', authHandler); // Express 5
```

(Express 4 keeps the legacy `'/api/auth/*'` syntax.)

### 5. Bind the per-request `Request` via `AsyncLocalStorage`

`RequestContext`'s factory runs lazily inside server methods (e.g.
`auth.getSession()`), long after Express/Fastify has handed off the request.
Stash the Fetch `Request` you built in step 1 into an `AsyncLocalStorage` so
the context factory can read it back:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

export const requestStorage = new AsyncLocalStorage<{ request: Request }>();

export const createNodeRequestContext: RequestContextFactory = () => {
  const store = requestStorage.getStore();
  if (!store) throw new Error('Neon Auth: no request bound — call inside requestStorage.run()');
  // …return a RequestContext that reads cookies/headers from store.request
};

// In your route handler / middleware, wrap the work in `.run(...)`:
app.use((req, res, next) => {
  const fetchReq = toFetchRequest(req, req.body as Buffer);
  requestStorage.run({ request: fetchReq }, () => next());
});
```

### 6. ESM-only — `require()` works on Node ≥ 22.12

`@neon/auth` ships ESM only. On modern Node, the CJS-to-ESM
interop in 22.12+ lets you `require('@neon/auth/server')` directly.
On older runtimes, use a dynamic import:

```typescript
const { createAuthServer } = await import('@neon/auth/server');
```

## What the toolkit gives you for free

You get these without writing any code:

| Concern | Toolkit primitive |
|---|---|
| Upstream URL composition + header forwarding | `handleAuthProxyRequest` |
| Set-Cookie sanitization (Partitioned, SameSite, domain) | `handleAuthResponse` |
| Session-data cookie minting + signing | internal to `handleAuthProxyRequest` |
| Session validation on protected routes | `processAuthMiddleware` |
| OAuth `?code=` exchange + verifier cookie cleanup | internal to `processAuthMiddleware` |
| Route-skip matcher | `shouldProtectRoute`, `checkSessionRequired` |
| Network error classification (`NETWORK_DNS`, `NETWORK_TIMEOUT`, …) | `classifyFetchFailure`, `NEON_AUTH_NETWORK_ERROR_CODES` |
| Structured logging (`logger` + `logLevel`) | `resolveNeonAuthLogging` |
| Cookie config validation | `validateCookieConfig` |
| Cookie name constants | `NEON_AUTH_SESSION_COOKIE_NAME`, … |

## Testing your adapter

The toolkit is fully unit-tested upstream — your adapter only needs to test
the framework-specific bridge:

1. **`RequestContext` integration**: assert your `getCookies`, `setCookie`,
   `getHeader`, `getOrigin` correctly read from / write to your framework's
   request/response objects.
2. **Handler routing**: assert `/api/auth/sign-in/email` is correctly forwarded
   to `handleAuthProxyRequest` with `['sign-in', 'email']`.
3. **Middleware mapping**: assert each `MiddlewareResult.action` produces the
   right framework response (200 / 302 / Set-Cookie pass-through).

The Next.js adapter's tests in
[`src/next/server/`](./src/next/server/) are a useful template.

## Known limitations

A few things are intentionally not surfaced through the toolkit yet. If any of
these blocks your adapter, please open an issue.

### `fetchOptions` on server methods is not forwarded upstream

Better Auth's client API accepts a second `fetchOptions` argument
(`auth.signIn.email(data, fetchOptions)`) carrying browser-oriented hooks like
`onSuccess`, `onError`, `throw`, `query`, etc. The toolkit's server proxy
intentionally **discards** `fetchOptions` and only forwards the data payload
and the method name to the upstream Neon Auth server.

Rationale:

- Most client-side hooks (`onSuccess`, `onError`, `throw`) are framework
  callbacks that don't translate to a server-to-server proxy.
- Forwarding arbitrary `headers` would bypass the toolkit's own cookie
  sanitization (`Partitioned` stripping, `SameSite` policy, domain assignment).
- `signal` (AbortSignal) and `query` may be worth wiring through in a future
  iteration — please open an issue with a concrete use case.

If your adapter needs to inject custom headers on every upstream call (e.g.
client telemetry), wrap your `RequestContext.getHeader` to expose them and
the toolkit will pick them up.

### Error narrowing: use `NeonAuthServerApiError`, not `instanceof AuthError`

Server methods returned by `createAuthServer` return
`{ data, error: NeonAuthServerApiError | null }` envelopes. Narrow on
`error.code`:

```ts
import { NEON_AUTH_NETWORK_ERROR_CODES } from '@neon/auth/server';

const { data, error } = await auth.signIn.email({ email, password });
if (error) {
  if (NEON_AUTH_NETWORK_ERROR_CODES.includes(error.code)) {
    // Upstream unreachable — retryable
  } else if (error.code === 'INTERNAL_ERROR') {
    // Toolkit-level bug — log and surface
  } else {
    // Upstream business error (`bad_credentials`, `rate_limited`, …)
    // — show error.message to the user
  }
}
```

The Supabase-flavored `AuthError` / `AuthApiError` classes are **not** exposed
on `@neon/auth/server` (they're vendor-coupled and risk
`instanceof`-across-realms failures). They remain available for
`SupabaseAuthAdapter` consumers via `@neon/auth/vanilla/adapters`.

## Versioning

The `@neon/auth/server` subpath is **beta**. While it is in beta:

- We will avoid breaking changes whenever possible.
- Any breaking change ships in a minor version (`0.x.0`), with a CHANGELOG
  entry describing the change and a one-step migration.
- When the surface stabilizes we'll move it to stable in a minor release
  with a changelog note.

Please open an issue at <https://github.com/neondatabase/neon-pkgs/issues> if
you hit a friction point — the toolkit shape will be informed by what
adapter authors actually need.

## Reference

- Next.js adapter source: [`src/next/server/`](./src/next/server/)
- Toolkit entry: [`src/server/index.ts`](./src/server/index.ts)
- TanStack Start adapter PR (in progress): <https://github.com/neondatabase/neon-js/pull/73>
