# @neon/auth/next

[![npm downloads](https://img.shields.io/npm/dm/@neon/auth.svg)](https://www.npmjs.com/package/@neon/auth)

A Next.js integration for **Neon Auth** (`@neon/auth`). This guide demonstrates how to integrate Neon's authentication system with a modern Next.js 15+ application.

## Features

- 🔐 **Email OTP Authentication** - Passwordless login with email verification
- 🔗 **Social Login** - Google OAuth integration
- 👥 **Organizations** - Multi-tenant organization support
- 🎨 **Pre-built UI Components** - Beautiful, customizable auth views
- ⚡ **React Server Components** - Access session data in RSC
- 🌙 **Dark Mode Support** - Built-in theme support

## Setup Guide

### 1. Install the Package

```bash
npm install @neon/auth @neondatabase/auth-ui
# or
pnpm add @neon/auth @neondatabase/auth-ui
# or
yarn add @neon/auth @neondatabase/auth-ui
```

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

export const { GET, POST } = auth.handler();
```

**Proxy:**

Create a `proxy.ts` file in your project root to protect routes and handle session validation:

```typescript
// proxy.ts
import { auth } from '@/lib/auth/server';

export default auth.middleware({ loginUrl: '/auth/sign-in' });

export const config = {
  matcher: [
    // Match all paths except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
}
```

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

### 5. Set Up the Neon Auth UI Provider

Create a providers component and wrap your application with `NeonAuthUIProvider`:

```typescript
// app/providers.tsx
"use client"

import { NeonAuthUIProvider } from "@neondatabase/auth-ui"
import Link from "next/link"
import { useRouter } from "next/navigation"
import type { ReactNode } from "react"

import { authClient } from "@/lib/auth/client"

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter()

  return (
    <NeonAuthUIProvider
      authClient={authClient}
      navigate={router.push}
      replace={router.replace}
      onSessionChange={() => {
        // Clear router cache (protected routes)
        router.refresh()
      }}
      emailOTP
      social={{
        providers: ["google"],
      }}
      redirectTo="/dashboard"
      Link={Link}
      organization={{}}
    >
      {children}
    </NeonAuthUIProvider>
  )
}
```

Then wrap your layout:

```typescript
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

### 6. Import CSS Styles

Choose the import method based on your project setup:

#### Option A: Without Tailwind CSS (recommended for most users)

If your project doesn't use Tailwind CSS, import the pre-built CSS bundle:

```typescript
// In your root layout or app entry point
import "@neondatabase/auth-ui/css"
```

This includes all necessary styles with no additional configuration required.

#### Option B: With Tailwind CSS

If your project already uses Tailwind CSS v4, import the Tailwind-ready CSS to avoid duplicate styles:

```css
/* In your main CSS file (e.g., globals.css) */
@import "tailwindcss";
@import "@neondatabase/auth-ui/tailwind";
```

This imports only the theme variables and component scanning directive. Your Tailwind build will generate the necessary utility classes, avoiding duplication with your existing Tailwind setup.

### 7. Create Auth Pages

#### Auth Page (Sign In, Sign Up, etc.)

Create a dynamic route file at `app/auth/[path]/page.tsx` to handle all authentication views:

```typescript
// app/auth/[path]/page.tsx
import { AuthView } from "@neondatabase/auth-ui"
import { authViewPaths } from "@neondatabase/auth-ui/server"

export const dynamicParams = false

export function generateStaticParams() {
  return Object.values(authViewPaths).map((path) => ({ path }))
}

export default async function AuthPage({
  params,
}: {
  params: Promise<{ path: string }>
}) {
  const { path } = await params

  return (
    <main className="container flex grow flex-col items-center justify-center p-4">
      <AuthView path={path} />
    </main>
  )
}
```

This automatically handles the following authentication routes:

- `/auth/sign-in` - Sign in page
- `/auth/sign-up` - Sign up page
- `/auth/magic-link` - Magic link authentication
- `/auth/forgot-password` - Password reset request
- `/auth/two-factor` - Two-factor authentication
- `/auth/recover-account` - Account recovery
- `/auth/reset-password` - Password reset
- `/auth/sign-out` - Sign out
- `/auth/callback` - OAuth callback
- `/auth/accept-invitation` - Accept team invitation

#### Account Page

```typescript
// app/account/[path]/page.tsx
import { AccountView } from "@neondatabase/auth-ui"
import { accountViewPaths } from "@neondatabase/auth-ui/server"

export const dynamicParams = false

export function generateStaticParams() {
  return Object.values(accountViewPaths).map((path) => ({ path }))
}

export default async function AccountPage({
  params,
}: {
  params: Promise<{ path: string }>
}) {
  const { path } = await params

  return (
    <main className="container p-4">
      <AccountView path={path} />
    </main>
  )
}
```

#### Organization Page

```typescript
// app/organization/[path]/page.tsx
import { OrganizationView } from "@neondatabase/auth-ui"
import { organizationViewPaths } from "@neondatabase/auth-ui/server"

export const dynamicParams = false

export function generateStaticParams() {
  return Object.values(organizationViewPaths).map((path) => ({ path }))
}

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ path: string }>
}) {
  const { path } = await params

  return (
    <main className="container p-4">
      <OrganizationView path={path} />
    </main>
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
├── account/
│   └── [path]/
│       └── page.tsx          # Account management views
├── organization/
│   └── [path]/
│       └── page.tsx          # Organization views
├── dashboard/
│   └── page.tsx              # Protected dashboard page
├── providers.tsx             # NeonAuthUIProvider setup
├── layout.tsx                # Root layout with providers
└── globals.css               # Global styles with Neon Auth CSS

lib/
└── auth
│   └── client.ts              # Auth client instance
│   └── server.ts              # Auth server instance

proxy.ts                       # Next.js middleware for session validation and route protection
```

## Learn More

- [Neon Auth Documentation](https://neon.com/docs/guides/neon-auth)
- [better-auth-ui Documentation](https://better-auth-ui.com/integrations/next-js)
- [Next.js Documentation](https://nextjs.org/docs)
- [Better Auth Session Management](https://www.better-auth.com/docs/concepts/session-management)
