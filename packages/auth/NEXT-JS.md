# @neon/auth/next

[![npm downloads](https://img.shields.io/npm/dm/@neon/auth.svg)](https://www.npmjs.com/package/@neon/auth)

A Next.js integration for **Neon Auth** (`@neon/auth`). This guide demonstrates how to integrate Neon's authentication system with a modern Next.js 16+ application.

## Features

- 🔐 **Email OTP Authentication** - Passwordless login with email verification
- 🔗 **Social Login** - Google OAuth integration
- 👥 **Organizations** - Multi-tenant organization support
- 🎨 **Pre-built UI Components** - Customizable auth views from Better Auth UI, copied into your app with shadcn
- ⚡ **React Server Components** - Access session data in RSC
- 🌙 **Dark Mode Support** - Built-in theme support

## Setup Guide

### 1. Install the Packages

```bash
npm i @neon/auth @better-auth-ui/core @better-auth-ui/react @tanstack/react-query
npx shadcn@latest init
npx shadcn@latest add @better-auth-ui/auth @better-auth-ui/settings @better-auth-ui/user-button
# add @better-auth-ui/email-otp as well if you use Email OTP
npm i better-auth@~1.7.12
```

[Better Auth UI](https://better-auth-ui.com) 1.7 copies its components into your app with the shadcn CLI; `@better-auth-ui/react` is the data layer behind them. Run the last command after your final `shadcn add`: the registry items list a bare `better-auth`, which installs the npm `latest` tag (which can be a pre-release) as a second copy next to the version `@neon/auth` uses.

Don't add `overrides`, `resolutions`, or exact pins for `better-auth`, and don't call `betterAuth()` yourself: Neon hosts the auth server.

### 2. Set Environment Variables

Export the required environment variables for Neon Auth:

```bash
# .env.local
NEON_AUTH_BASE_URL=https://your-neon-auth-url.neon.tech

# Cookie secret for session data signing (required for session caching)
# Generate a random 32+ character string for production
NEON_AUTH_COOKIE_SECRET=your-secret-at-least-32-characters-long
```

**Important**: The `NEON_AUTH_COOKIE_SECRET` must be at least 32 characters long. Generate a secure random string for production:

```bash
# Generate a secure secret
openssl rand -base64 32
```

### 3. Setting up auth server

The `createNeonAuth()` function provides a single entry point for all server-side functionalities:

1. A auth route handler to proxy API calls from frontend client
2. A middleware to verify session and protect application routes
3. Auth APIs to be consumed from React server components and application API handlers

```typescript
// lib/auth/server.ts
import { createNeonAuth } from '@neon/auth/next/server';

export const auth = createNeonAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  cookies: {
    secret: process.env.NEON_AUTH_COOKIE_SECRET!,
    sessionDataTtl: 300,          // Optional: session data cache TTL in seconds (default: 300 = 5 min)
    domain: ".example.com",        // Optional: for cross-subdomain cookies
  },
});
```

**API Route Handler:**

Create a route file inside `/api/auth/[...path]` directory with following content:

```typescript
// app/api/auth/[...path]/route.ts
import { auth } from '@/lib/auth/server';

export const { GET, POST, PUT, DELETE, PATCH } = auth.handler();
```

**Proxy:**

Create a `proxy.ts` file in your project root to protect routes and handle session validation:

```typescript
// proxy.ts
import { auth } from '@/lib/auth/server';

export default auth.middleware({
  loginUrl: '/auth/sign-in',
  publicRoutes: ['/'],
});

export const config = {
  matcher: [
    // Match all paths except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
}
```

The middleware lets signed-out users reach the auth API (`/api/auth`) and every signed-out Better Auth UI 1.7 view (`/auth/sign-in`, `/auth/reset-password`, `/auth/verify-email`, and the rest). `/auth` itself and `/settings/*` stay protected. Everything else requires a session, so you don't need a custom `proxy.ts` wrapper for the auth views.

`publicRoutes` adds your own public pages to those defaults. Each entry matches the exact path and its slash-delimited subpaths (`/pricing` matches `/pricing` and `/pricing/team`, but not `/pricing-internal`). `'/'` matches only the home page, not the whole site. Trailing slashes are trimmed (`/pricing/` is the same as `/pricing`). Entries must start with `/`; invalid entries (`''`, `'//'`, or no leading `/`) throw when the middleware is created.

**Server Components:**
```typescript
// app/dashboard/page.tsx
import { auth } from '@/lib/auth/server';

// Server components using `auth` methods must be rendered dynamically
export const dynamic = 'force-dynamic'

export default async function Page() {
  const { data: session } = await auth.getSession();
  if (!session?.user) return <div>Not logged in</div>;
  return <div>Hello {session.user.name}</div>;
}
```

**Server Actions:**
```typescript
'use server';
import { auth } from '@/lib/auth/server';
import { redirect } from 'next/navigation';

export async function signIn(formData: FormData) {
  const { error } = await auth.signIn.email({
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  });
  if (error) return { error: error.message };
  redirect('/dashboard');
}
```

### 4. Create the Auth Client

Create a client instance that can be used in client components to sign up, sign in, and perform other auth-related actions:

```typescript
// lib/auth/client.ts
"use client"

import { createAuthClient } from "@neon/auth/next"

export const authClient = createAuthClient()
```

### 5. Set Up the Auth Provider

Create a providers component with a TanStack Query `QueryClientProvider` and the `AuthProvider` that `shadcn add` copied to `components/auth/auth-provider`. Pass the client from step 4 as `authClient`; it needs no adapter or type cast.

```tsx
// app/providers.tsx
"use client"

import { getSafeRedirectTo } from "@better-auth-ui/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, type ReactNode } from "react"

import { AuthProvider } from "@/components/auth/auth-provider"
import { Toaster } from "@/components/ui/sonner"
import { authClient } from "@/lib/auth/client"

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [queryClient] = useState(() => new QueryClient())

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider
        authClient={authClient}
        navigate={({ to, replace }) => {
          const path = getSafeRedirectTo(to, window.location.origin)
          const target = path.startsWith("//") ? "/" : path
          if (replace) router.replace(target)
          else router.push(target)
        }}
        Link={Link}
        redirectTo="/dashboard"
      >
        {children}
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  )
}
```

Render `<Toaster />` once: the components report errors as toasts. Set `emailAndPassword={{ requireEmailVerification: true }}` if your branch has **Verify email at signup** on, and pass Better Auth UI plugins through `plugins` (for example `plugins={[emailOtpPlugin()]}` with `emailOtpPlugin` from the `lib/auth/email-otp-plugin` file that `@better-auth-ui/email-otp` copies). A UI plugin doesn't enable the matching Neon Auth plugin; configure that on the branch first.

#### Validate redirect targets

After sign-in, the components call `navigate` with the `?redirectTo=` value from the URL. Check it before you navigate, as in the example above, so a link like `/auth/sign-in?redirectTo=https://example.com` can't send a signed-in user to another site. `getSafeRedirectTo` returns `/` for other origins, but `@better-auth-ui/core` 1.7.30 can still return a protocol-relative path such as `//example.com` for some crafted inputs, so also reject a result that starts with `//`.

The `/auth/redirect` view navigates without `navigate`. Apply the same check to the copied `components/auth/auth-redirect.tsx`:

```tsx
// components/auth/auth-redirect.tsx
window.location.replace(action.to) // before
window.location.replace(action.to.startsWith("//") ? "/" : action.to) // after
```

Both checks can go once Better Auth UI fixes this in `getSafeRedirectTo`.

Then wrap your layout:

```tsx
// app/layout.tsx
import { Providers } from "./providers"
import "./globals.css"

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
```

### 6. Styling

The copied components are compiled by your app's Tailwind build and use the shadcn/ui theme variables that `shadcn init` added to your global CSS. There are no CSS files to import; edit the theme variables or the files in `components/auth/` to restyle them.

### 7. Create Auth and Settings Pages

#### Auth Page (Sign In, Sign Up, etc.)

Create a dynamic route file at `app/auth/[path]/page.tsx` to handle all authentication views. The valid paths come from `viewPaths.auth` in `@better-auth-ui/core`:

```tsx
// app/auth/[path]/page.tsx
import { viewPaths } from "@better-auth-ui/core"
import { notFound } from "next/navigation"

import { Auth } from "@/components/auth/auth"

const validAuthPaths = new Set<string>(Object.values(viewPaths.auth))

export default async function AuthPage({
  params,
}: {
  params: Promise<{ path: string }>
}) {
  const { path } = await params
  if (!validAuthPaths.has(path)) notFound()

  return (
    <main className="container flex grow flex-col items-center justify-center p-4">
      <Auth path={path} />
    </main>
  )
}
```

This serves every auth view, including `/auth/sign-in`, `/auth/sign-up`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/verify-email`, `/auth/magic-link`, `/auth/two-factor`, `/auth/callback`, `/auth/sign-out`, and `/auth/accept-invitation`. See `viewPaths.auth` for the full list. If you use Email OTP, also allow `Object.values(emailOtpPlugin().viewPaths.auth ?? {})` with `emailOtpPlugin` from `@better-auth-ui/core/plugins/email-otp`.

#### Settings Page

The user menu's **Settings** link opens `/settings/account`. Create `app/settings/[path]/page.tsx` for it:

```tsx
// app/settings/[path]/page.tsx
import { viewPaths } from "@better-auth-ui/core"
import { notFound } from "next/navigation"

import { Settings } from "@/components/auth/settings/settings"

const validSettingsPaths = new Set<string>(Object.values(viewPaths.settings))

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ path: string }>
}) {
  const { path } = await params
  if (!validSettingsPaths.has(path)) notFound()

  return (
    <main className="container p-4">
      <Settings path={path} />
    </main>
  )
}
```

#### User Button

Add the user menu to a header with the copied `UserButton`. Pass `hideSettings` if you skip the settings page:

```tsx
import { UserButton } from "@/components/auth/user/user-button"

export function Header() {
  return (
    <header>
      <UserButton size="icon" />
    </header>
  )
}
```

## Accessing Session Data

### React Server Components

Use the `auth.getSession()` function to access session and user data in React Server Components:

```typescript
// app/components/session-card.tsx
import { auth } from "@/lib/auth/server"

export async function SessionCard() {
  const { session, user } = await auth.getSession()
  const isLoggedIn = !!session && !!user

  if (!isLoggedIn) {
    return <div>Not logged in</div>
  }

  return (
    <div>
      <p>Welcome, {user.name || user.email}</p>
      <p>User ID: {user.id}</p>
      <p>Session expires: {new Date(session.expiresAt).toLocaleString()}</p>
      {user.image && <img src={user.image} alt="User avatar" />}
    </div>
  )
}
```

### Client Components

For client components, use the `authClient.useSession()` hook:

```typescript
// app/dashboard/page.tsx
"use client"

import { authClient } from "@/lib/auth/client"

export default function DashboardPage() {
  const { data: session, isPending } = authClient.useSession()

  if (isPending) {
    return <div>Loading...</div>
  }

  if (!session) {
    return <div>Not authenticated</div>
  }

  return (
    <div>
      <h1>Welcome, {session.user.name || session.user.email}</h1>
      <p>User ID: {session.user.id}</p>
      <p>Session ID: {session.session.id}</p>
    </div>
  )
}
```

### Server Action Example

For Server Actions, Route Handlers, and other server-side auth operations, use API methods through `auth` instance from `@/lib/auth/server`:

```typescript
// app/actions.ts
'use server';
import { auth } from '@/lib/auth/server';
import { redirect } from 'next/navigation';

export async function signIn(formData: FormData) {
  const { error } = await auth.signIn.email({
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  });
  if (error) return { error: error.message };
  redirect('/dashboard');
}

export async function signOut() {
  await auth.signOut();
  redirect('/auth/sign-in');
}
```

### Available APIs

The `auth` provides access to all Neon Auth APIs:

- **Session**: `getSession()`, `listSessions()`, `revokeSession()`, `revokeOtherSessions()`
- **Auth**: `signIn.email()`, `signIn.social()`, `signIn.emailOtp()`, `signUp.email()`, `signOut()`
- **User**: `updateUser()`, `changePassword()`, `deleteUser()`, `sendVerificationEmail()`
- **Organization**: `organization.create()`, `organization.list()`, `organization.inviteMember()`, `organization.removeMember()`, etc.
- **Admin**: `admin.listUsers()`, `admin.banUser()`, `admin.setRole()`, `admin.createUser()`, etc.
- **Email OTP**: `emailOtp.sendVerificationOtp()`, `emailOtp.verifyEmail()`
- **OAuth provider**: `oauth2.publicClient()`, `oauth2.consent()`, `oauth2.getConsents()`, etc.

## OAuth provider (MCP)

A Neon Auth project can act as an OAuth 2.1 provider, for example to let MCP clients sign in your users. The provider's login and consent pages are pages of your app, and the client exposes the `oauth2` namespace for them; no configuration is needed:

```typescript
// lib/auth/client.ts
"use client"

import { createAuthClient } from '@neon/auth/next';

export const authClient = createAuthClient();
```

When the page URL carries the signed `sig` and `ba_param` query parameters that the provider appended on redirect, the client adds them as `oauth_query` to every non-GET request, so a sign-in on the login page resumes the authorization. Without those parameters requests are unchanged.

A login page resumes the authorization in two cases: the user signs in on it, or the user is already signed in. On every load, including the redirect back from a social sign-in, call `getSession()` to check the sign-in and then `oauth2.continue({ selected: true })`. Use the same path for the login page URL configured for the OAuth provider in Neon Auth and the middleware's `loginUrl`, so the middleware never redirects away from it. Failed requests reject with an error that has a `status`:

```tsx
'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth/client';

const message = (err: unknown) => (err instanceof Error ? err.message : 'Sign-in failed');

export default function LoginPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const isOAuthVisit = params.has('client_id');
    // `login` and `create` ask the user to sign in again, so continuing would come back here.
    const mustSignInAgain =
      isOAuthVisit && /\b(login|create)\b/.test(params.get('prompt') ?? '');

    (async () => {
      try {
        const { data: session } = await authClient.getSession();
        if (!session || mustSignInAgain) return setChecking(false);
        if (!isOAuthVisit) return router.replace('/');
        // Keeps the loading state: the SDK navigates to the consent page or back to the client.
        await authClient.oauth2.continue({ selected: true });
      } catch (err) {
        // 400: the link expired, and only the client app can start a new authorization.
        if (isOAuthVisit && (err as { status?: number } | undefined)?.status === 400) setExpired(true);
        else setError(message(err));
        setChecking(false);
      }
    })();
  }, [router]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const { data } = await authClient.signIn.email({
        email: String(form.get('email')),
        password: String(form.get('password')),
      });
      // On an OAuth visit the SDK is already navigating to the consent page or back to the client.
      if (!data?.redirect) router.push('/');
    } catch (err) {
      setError(message(err));
    }
  }

  async function signInWithGoogle() {
    try {
      // Come back to this page so the check above can continue the authorization.
      await authClient.signIn.social({ provider: 'google', callbackURL: window.location.href });
    } catch (err) {
      setError(message(err));
    }
  }

  if (checking) return <p>Loading...</p>;
  if (expired) return <p role="alert">This sign-in link has expired. Go back to the app and try again.</p>;

  return (
    <form onSubmit={onSubmit}>
      <input name="email" type="email" required />
      <input name="password" type="password" required />
      <button type="submit">Sign in</button>
      <button type="button" onClick={signInWithGoogle}>
        Continue with Google
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

On success `oauth2.continue()` navigates to the consent page or back to the client app, like `oauth2.consent()` below. A 400 means the link has expired; show a message rather than the form, because signing in again can't resume it. Other errors, such as a network failure, leave the form available to retry. The same component works in a Vite SPA with `createAuthClient()` from `@neon/auth` and your router's navigate function in place of `useRouter`.

A consent page reads the client from the URL and answers with `oauth2.consent`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { authClient } from '@/lib/auth/client';

export default function ConsentPage() {
  const [scope, setScope] = useState<string | null>(null);
  const [client, setClient] = useState<{ client_name?: string; logo_uri?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read the query in an effect: the page also renders on the server, where `window` is undefined.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setScope(params.get('scope'));
    authClient.oauth2
      .publicClient({ query: { client_id: params.get('client_id') ?? '' } })
      .then(({ data }) => setClient(data))
      .catch(() => setError('This request could not be completed. Go back to the app and try again.'));
  }, []);

  const answer = (accept: boolean) =>
    authClient.oauth2
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

## Handling Errors

A failed `authClient` request throws an `AuthHttpError` (a public type export of `@neon/auth/next`). `.code` and `.status` are Supabase-style. `.error` is the raw Better Auth body, `{ code, message, status }`, where `status` is the raw HTTP status. Better Auth UI reads that body to show specific messages, such as invalid credentials.

## Project Structure

```
app/
├── api/
│   └── auth/
│       └── [...path]/
│           └── route.ts      # Auth API handlers
├── auth/
│   └── [path]/
│       └── page.tsx          # Auth views (sign-in, sign-up, etc.)
├── settings/
│   └── [path]/
│       └── page.tsx          # Account and security settings views
├── dashboard/
│   └── page.tsx              # Protected dashboard page
├── providers.tsx             # QueryClientProvider and AuthProvider setup
├── layout.tsx                # Root layout with providers
└── globals.css               # Global styles with the shadcn theme

components/
├── auth/                     # Components copied by `shadcn add @better-auth-ui/*`
└── ui/                       # shadcn/ui primitives

lib/
└── auth
│   └── client.ts              # Auth client instance
│   └── server.ts              # Auth server instance

proxy.ts                       # Next.js middleware for session validation and route protection
```

## Learn More

- [Neon Auth Documentation](https://neon.com/docs/guides/neon-auth)
- [Better Auth UI Documentation](https://better-auth-ui.com/docs)
- [UI Components Reference](https://neon.com/docs/auth/reference/ui-components)
- [Next.js Documentation](https://nextjs.org/docs)
- [Better Auth Session Management](https://www.better-auth.com/docs/concepts/session-management)
