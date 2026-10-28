# @neon/auth

[![npm version](https://img.shields.io/npm/v/@neon/auth.svg)](https://www.npmjs.com/package/@neon/auth)
[![npm downloads](https://img.shields.io/npm/dm/@neon/auth.svg)](https://www.npmjs.com/package/@neon/auth)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/@neon/auth.svg)](https://github.com/neondatabase/neon-pkgs/blob/main/LICENSE)

Authentication adapters for Neon Auth, supporting multiple auth providers.

## Overview

`@neon/auth` provides authentication for applications using Neon Auth. By default, it uses the Better Auth API, with optional adapters for different API styles:

- **Default** - Better Auth API (`signIn.email`, `signUp.email`, etc.)
- **SupabaseAuthAdapter** - Supabase-compatible API for migrations (`signInWithPassword`, `signUp`, etc.)
- **BetterAuthReactAdapter** - Better Auth with React hooks (`useSession`)

This package is designed to work seamlessly with Neon's authentication infrastructure while providing:

- **Simple default API** - Works out of the box with Better Auth patterns
- **Optional adapters** - Switch API styles for migrations or preferences
- **Anonymous access** - Optional RLS-based data access for unauthenticated users
- **Performance optimizations** - Session caching and request deduplication
- **TypeScript support** - Fully typed with strict type checking

## Why @neon/auth?

### vs. better-auth/client

`@neon/auth` is a wrapper around Better Auth that provides:

**API Flexibility:**
- Multiple adapters (Supabase-compatible, React hooks, vanilla)
- Restricted options to match Neon Auth capabilities

**Neon Auth Integration:**
- Automatic `token_verifier` on OAuth callback
- Pre-configured plugins for Neon Auth
- Automatic JWT extraction from sessions
- Popup-based OAuth flow for iframes

**Built-in Enhancements:**
- Session caching (60s TTL)
- Request deduplication
- Event system
- Cross-tab sync
- Token refresh detection

If you're not using Neon Auth, you should probably use `better-auth/client` directly for more flexibility.

## Installation

```bash
npm install @neon/auth
# or
bun add @neon/auth
```

## Usage

### Basic Usage (Default)

The `createAuthClient` factory function creates an auth client. By default, it uses the Better Auth API:

```typescript
import { createAuthClient } from '@neon/auth';

const auth = createAuthClient('https://your-auth-server.com');

// Sign up
await auth.signUp.email({
  email: 'user@example.com',
  password: 'secure-password',
  name: 'John Doe',
});

// Sign in
await auth.signIn.email({
  email: 'user@example.com',
  password: 'secure-password',
});

// Get session
const session = await auth.getSession();

// Sign out
await auth.signOut();
```

### OAuth Authentication

```typescript
import { createAuthClient } from '@neon/auth';

const auth = createAuthClient('https://your-auth-server.com');

await auth.signIn.social({
  provider: 'google',
  callbackURL: '/dashboard',
});
```

## Using Adapters

You can optionally specify an adapter to change the API style. This is useful for migrations or if you prefer a different API.

### SupabaseAuthAdapter - Supabase-compatible API

Use this adapter if you're migrating from Supabase or prefer the Supabase API style:

```typescript
import { createAuthClient, SupabaseAuthAdapter } from '@neon/auth';

const auth = createAuthClient('https://your-auth-server.com', {
  adapter: SupabaseAuthAdapter(),
});

// Supabase-compatible methods
await auth.signUp({
  email: 'user@example.com',
  password: 'secure-password',
  options: {
    data: { name: 'John Doe' },
  },
});

await auth.signInWithPassword({
  email: 'user@example.com',
  password: 'secure-password',
});

const { data: session } = await auth.getSession();
await auth.signOut();

// OAuth with Supabase-style API
await auth.signInWithOAuth({
  provider: 'google',
  options: {
    redirectTo: '/dashboard',
  },
});
```

### BetterAuthReactAdapter - React Hooks Support

Use this adapter in React applications to get access to hooks like `useSession`:

```typescript
import { createAuthClient } from '@neon/auth';
import { BetterAuthReactAdapter } from '@neon/auth/react/adapters';

const auth = createAuthClient('https://your-auth-server.com', {
  adapter: BetterAuthReactAdapter(),
});

// Same API as default
await auth.signIn.email({
  email: 'user@example.com',
  password: 'secure-password',
});

// Plus React hooks
function MyComponent() {
  const session = auth.useSession();

  if (session.isPending) return <div>Loading...</div>;
  if (!session.data) return <div>Not logged in</div>;

  return <div>Hello, {session.data.user.name}</div>;
}
```

## OAuth provider (MCP)

A Neon Auth project can act as an OAuth 2.1 provider, for example to let MCP clients sign in your users. The provider's login and consent pages are pages of your app, and the client exposes the `oauth2` namespace for them; no configuration is needed:

```typescript
import { createAuthClient } from '@neon/auth';

export const auth = createAuthClient('https://your-auth-server.com');
```

When the page URL carries the signed `sig` and `ba_param` query parameters that the provider appended on redirect, the client adds them as `oauth_query` to every non-GET request, so a sign-in on the login page resumes the authorization. Without those parameters requests are unchanged.

A login page resumes the authorization in two cases: the user signs in on it, or the user is already signed in. On every load, including the redirect back from a social sign-in, call `getSession()` to check the sign-in and then `oauth2.continue({ selected: true })` (use the same path for the login page URL configured for the OAuth provider in Neon Auth and the middleware's `loginUrl`), which navigates to the consent page or back to the client app. Skip it when `prompt` contains `login` or `create`, which ask the user to sign in again. A 400 from `continue` means the link has expired; show a message instead of the form. After `signIn.email`, skip your own redirect when `data.redirect` is true: the SDK is already navigating. See the [login page example](./NEXT-JS.md#oauth-provider-mcp) in the Next.js guide; the same component works in a Vite SPA.

A consent page reads the client from the URL and answers with `oauth2.consent`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { auth } from '@/lib/auth/client';

export default function ConsentPage() {
  const [scope, setScope] = useState<string | null>(null);
  const [client, setClient] = useState<{ client_name?: string; logo_uri?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read the query in an effect: the page also renders on the server, where `window` is undefined.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setScope(params.get('scope'));
    auth.oauth2
      .publicClient({ query: { client_id: params.get('client_id') ?? '' } })
      .then(({ data }) => setClient(data))
      .catch(() => setError('This request could not be completed. Go back to the app and try again.'));
  }, []);

  const answer = (accept: boolean) =>
    auth.oauth2
      .consent({ accept })
      .catch(() => setError('This request could not be completed. Go back to the app and try again.'));

  if (error) return <p role="alert">{error}</p>;

  return (
    <div>
      <p>{client?.client_name ?? 'An application'} wants to access: {scope}</p>
      <button onClick={() => answer(true)}>Allow</button>
      <button onClick={() => answer(false)}>Deny</button>
    </div>
  );
}
```

`oauth2.consent()` navigates the browser itself: it returns `{ redirect: true, url }`, and better-auth's default redirect fetch plugin sets `window.location.href`, so the page does not need to follow it. Pass `scope` (a space-separated subset of the requested scopes) to grant less than was requested; without it every requested scope is granted. Both `publicClient` and `consent` need a signed-in user.

Send `Content-Security-Policy: frame-ancestors 'none'` as a response header on the login and consent pages so they cannot be framed (browsers ignore `frame-ancestors` in a `<meta>` tag), and never build consent URLs yourself: the provider redirects with a signed query that `oauth2.consent()` forwards as it is.

The browser client's `oauth2.*` mirrors the full plugin. Neon mounts these endpoints:

| Group | Endpoints | In `createNeonAuth()` | Notes |
| --- | --- | --- | --- |
| Login and consent actions | `consent`, `continue`, `publicClient`, `publicClientPrelogin` | Yes | Drive your login and consent pages. |
| The user's own grants | `getConsent`, `getConsents`, `updateConsent`, `deleteConsent` | Yes | Let a signed-in user review and revoke what they granted. |
| Client management | `create-client`, `get-client`, `get-clients`, `update-client`, `delete-client`, `client/rotate-secret`, `client/rotate-keys` | No | Neon rejects these for end users with 401; manage clients through the Neon Console or API. |
| OAuth protocol | `authorize`, `token`, `introspect`, `revoke`, `userinfo`, `register` | No | Use client credentials or bearer tokens with form bodies or redirects. Relying parties and MCP servers should use `@neon/oauth`. |
| RP-initiated logout | `end-session`, `end-session/confirm` | No | Browser redirect flow. |

`createNeonAuth()` and `createAuthServer()` expose only the first two groups. A server-side consent example is not documented, because `oauth_query` has to be the signed query the provider redirected with and is only built automatically in the browser.

## Anonymous Access

Enable `allowAnonymous` to let unauthenticated users access data via RLS policies:

```typescript
import { createAuthClient } from '@neon/auth';

const auth = createAuthClient('https://your-auth-server.com', {
  allowAnonymous: true, // Enable anonymous data access
});

// Get token - returns anonymous token if no user session exists
const token = await auth.getJWTToken?.();
```

This is useful when you want to allow read-only public access to certain data while still enforcing RLS policies.

## API Reference

### createAuthClient(url, config?)

Factory function to create an auth client.

**Parameters:**
- `url` - The auth service URL (required)
- `config.adapter` - Optional adapter factory function (e.g., `SupabaseAuthAdapter()`)
- `config.allowAnonymous` - When `true`, returns an anonymous token if no user session exists (default: `false`)

**Returns:** The adapter's public API (varies by adapter type)

### Default API (Better Auth)

- `signIn.email(credentials)` - Sign in with email
- `signIn.social(options)` - Sign in with OAuth
- `signUp.email(credentials)` - Create new user
- `signOut()` - Sign out current user
- `getSession()` - Get current session

### SupabaseAuthAdapter API

Provides a Supabase-compatible API:

- `signUp(credentials)` - Create a new user
- `signInWithPassword(credentials)` - Sign in with email/password
- `signInWithOAuth(options)` - Sign in with OAuth provider
- `signOut()` - Sign out current user
- `getSession()` - Get current session
- `getUser()` - Get current user
- `updateUser(attributes)` - Update user metadata
- `getUserIdentities()` - Get linked OAuth identities
- `linkIdentity(credentials)` - Link OAuth provider
- `unlinkIdentity(identity)` - Unlink OAuth provider
- `resetPasswordForEmail(email, options)` - Send password reset
- `onAuthStateChange(callback)` - Listen to auth state changes

### BetterAuthReactAdapter API

Same as default API, plus:

- `useSession()` - React hook for session state

## Performance Features

### Session Caching

Sessions are cached in memory with intelligent TTL management:
- 60-second default cache TTL
- Automatic expiration based on JWT `exp` claim
- Lazy expiration checking on reads
- Synchronous cache clearing on sign-out

### Request Deduplication

Multiple concurrent `getSession()` calls are automatically deduplicated:
- Single network request for concurrent calls
- 10x faster cold starts (10 concurrent calls: ~2000ms → ~200ms)
- Reduces server load by N-1 for N concurrent calls

## Environment Compatibility

- Node.js 14+
- Browser (all modern browsers)
- Edge Runtime (Vercel, Cloudflare Workers, etc.)
- Bun

## Next.js Integration

For Next.js projects, this package provides built-in integration via `@neon/auth/next`. 
See the [Next.js Setup Guide](./NEXT-JS.md) for comprehensive documentation including:

- Setting up auth server instance with `createNeonAuth()` for handler, middleware and api methods  
- Client-side auth with `createAuthClient()` for client components
- Configuring the `NeonAuthUIProvider` with Email OTP, Social Login, and Organizations
- Creating auth pages (`AuthView`, `AccountView`, `OrganizationView`)
- Importing styles (with or without Tailwind CSS)
- Using `authClient.useSession()` hook in client components

## Server toolkit (for framework adapter authors)

> **Stability: beta.** Minor versions may include breaking changes with migration
> notes in the package CHANGELOG. Pin your peer dependency accordingly.

`@neon/auth/server` exposes the framework-agnostic primitives that the
bundled `@neon/auth/next/server` adapter is built on. Use it to build
adapters for additional server frameworks (Hono, Remix, SolidStart, Express,
Fastify, ...) without forking the package.

```typescript
import {
  createAuthServer,
  handleAuthProxyRequest,
  processAuthMiddleware,
  validateCookieConfig,
  resolveNeonAuthLogging,
  DEFAULT_AUTH_SKIP_ROUTES,
  type RequestContext,
  type NeonAuthConfig,
  type MiddlewareResult,
} from '@neon/auth/server';
```

The toolkit is **Web Standards only** — it consumes `Request`/`Response` and
exposes a small `RequestContext` interface that adapter authors implement for
their framework's cookie/header APIs. The bundled Next.js adapter is the
reference implementation; see [`BUILDING-AN-ADAPTER.md`](./BUILDING-AN-ADAPTER.md)
for a walkthrough.

## UI Components

Pre-built login forms and auth pages live in `@neondatabase/auth-ui`, a
separate package. `@neon/auth` does not ship the `react/ui` / `ui/*`
compatibility re-exports that older `@neondatabase/auth` releases carried —
install and import from `@neondatabase/auth-ui` directly.

If you're migrating off those deprecated re-export paths on an older
`@neondatabase/auth` release, change imports from `@neondatabase/auth/react/ui`
(and `@neondatabase/auth/ui/*`) to the matching `@neondatabase/auth-ui` paths.

### 1. Import CSS

Install the UI package alongside `@neon/auth`:

```bash
npm install @neondatabase/auth-ui
```

> **Note:** `@neondatabase/auth-ui` still depends on the legacy `@neondatabase/auth`
> release (an exact peer dependency, imported at runtime). Installing it alongside
> `@neon/auth` also installs `@neondatabase/auth`, and the UI provider's types resolve
> against that legacy package until `@neondatabase/auth-ui` is updated to accept `@neon/auth`.

**Without Tailwind CSS:**
```typescript
import '@neondatabase/auth-ui/css';
```

**With Tailwind CSS v4:**
```css
@import 'tailwindcss';
@import '@neondatabase/auth-ui/tailwind';
```

### 2. Setup Provider

```typescript
"use client"

import { NeonAuthUIProvider } from "@neondatabase/auth-ui"
import { createAuthClient } from "@neon/auth"
import "@neondatabase/auth-ui/css"

const authClient = createAuthClient('https://your-auth-url.com')

export function AuthProvider({ children }) {
  return (
    <NeonAuthUIProvider authClient={authClient} redirectTo="/dashboard">
      {children}
    </NeonAuthUIProvider>
  )
}
```

### 3. Use Components

**Option A: Full Auth Pages (Recommended)**

Use `AuthView` to render complete auth flows based on the URL path:

```typescript
import { AuthView } from "@neondatabase/auth-ui"

// Renders sign-in, sign-up, forgot-password, etc. based on path
<AuthView path="sign-in" />
```

**Option B: Individual Components**

```typescript
import { SignInForm, UserButton } from "@neondatabase/auth-ui"

<SignInForm />
<UserButton />
```

Available components: `SignInForm`, `SignUpForm`, `UserButton`, `AuthView`, `AccountView`, `OrganizationView`

For Next.js with dynamic routes, see the [Next.js Setup Guide](./NEXT-JS.md).

For full documentation and theming, see [`@neondatabase/auth-ui`](https://github.com/neondatabase/neon-js/tree/main/packages/auth-ui).

## Related Packages

- [`@neondatabase/neon-js`](https://github.com/neondatabase/neon-js/tree/main/packages/neon-js) - Legacy all-in-one SDK built on the `@neondatabase/*` packages (it does not use `@neon/auth`)
- [`@neon/postgrest-js`](../postgrest-js) - PostgREST client without auth

## Resources

- [Neon Auth Documentation](https://neon.com/docs/neon-auth)
- [Better Auth Documentation](https://www.better-auth.com/docs)

## Support

- [GitHub Issues](https://github.com/neondatabase/neon-pkgs/issues)
- [Neon Community Discord](https://discord.gg/H24eC2UN)

## License

Apache-2.0
