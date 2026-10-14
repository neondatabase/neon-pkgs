# @neon/neon-js

[![npm version](https://img.shields.io/npm/v/@neon/neon-js.svg)](https://www.npmjs.com/package/@neon/neon-js)
[![npm downloads](https://img.shields.io/npm/dm/@neon/neon-js.svg)](https://www.npmjs.com/package/@neon/neon-js)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/@neon/neon-js.svg)](https://github.com/neondatabase/neon-pkgs/blob/main/LICENSE)

The official TypeScript SDK for Neon, combining authentication and database querying in a familiar interface.

## Overview

`@neon/neon-js` is a comprehensive SDK that brings together Neon Auth and Neon Data API. It provides a unified client for managing authentication and querying PostgreSQL databases with a familiar, intuitive interface.

**Key Features:**

- **Integrated Authentication** - Works out of the box with optional adapters (Supabase-compatible, React hooks)
- **PostgreSQL Querying** - Full PostgREST client with type-safe queries
- **Anonymous Access** - Optional RLS-based data access for unauthenticated users
- **High Performance** - Session caching, request deduplication
- **Automatic Token Management** - Seamless token injection for database queries
- **TypeScript First** - Fully typed with strict type checking
- **Universal** - Works in Node.js, browsers, and edge runtimes

## How to query your Neon Serverless Postgres database?

It's up to you how you want to query your Postgres database! Neon Data API is a PostgREST-compatible REST service for your Neon database. `neon-js` exposes the REST-based query functions to leverage Data API. However, you can also use Data API directly with [PostgREST](https://postgrest.org) and we also maintain a simple Postgres client [here](https://github.com/neondatabase/serverless).

That said, you don't need Data API or `neon-js` to query Neon. Neon works great with all major ORMs ([Drizzle](https://orm.drizzle.team/), [Prisma](https://www.prisma.io/), [Kysely](https://kysely.dev/)) and Postgres clients ([node-postgres](https://node-postgres.com/), [postgres.js](https://github.com/porsager/postgres)). We also offer a [serverless driver](https://github.com/neondatabase/serverless) for edge and serverless environments without TCP client or connection pooling support (which also is available as a Drizzle and Prisma adapter).

## Installation

```bash
npm install @neon/neon-js
# or
bun add @neon/neon-js
```

## Prerequisites

Before using neon-js, you'll need:

### 1. A Neon Account and Project

- Sign up at [neon.tech](https://neon.tech)
- Create a new project in the Neon Console

### 2. Enable the Data API (for database queries)

- Go to your project settings in Neon Console
- Enable the Data API feature
- Copy your Data API URL

**Data API URL format:**
```
https://ep-xxx.apirest.c-2.us-east-2.aws.neon.build/dbname/rest/v1
```

### 3. Enable Neon Auth (for authentication)

- Go to your project settings in Neon Console
- Enable Neon Auth
- Copy your Auth URL

**Auth URL format:**
```
https://ep-xxx.neonauth.c-2.us-east-2.aws.neon.build/dbname/auth
```

### 4. Configure Environment Variables

Create a `.env` or `.env.local` file:

```bash
# Next.js
NEON_AUTH_BASE_URL=https://ep-xxx.neonauth.c-2.us-east-2.aws.neon.build/dbname/auth
NEXT_PUBLIC_NEON_AUTH_URL=https://ep-xxx.neonauth.c-2.us-east-2.aws.neon.build/dbname/auth
NEON_DATA_API_URL=https://ep-xxx.apirest.c-2.us-east-2.aws.neon.build/dbname/rest/v1

# Vite/React
VITE_NEON_AUTH_URL=https://ep-xxx.neonauth.c-2.us-east-2.aws.neon.build/dbname/auth
VITE_NEON_DATA_API_URL=https://ep-xxx.apirest.c-2.us-east-2.aws.neon.build/dbname/rest/v1
```

## Quick Start

```typescript
import { createClient } from '@neon/neon-js';

// `Database` is a type generated from your schema
// See "TypeScript" section below for details
const client = createClient<Database>({
  auth: {
    url: import.meta.env.VITE_NEON_AUTH_URL,
    // Optional: allow unauthenticated users to query data via RLS
    // allowAnonymous: true,
  },
  dataApi: {
    url: import.meta.env.VITE_NEON_DATA_API_URL,
  },
});

// Authenticate
await client.auth.signIn.email({
  email: 'user@example.com',
  password: 'secure-password',
});

// Query database (token automatically injected)
const { data: users } = await client
  .from('users')
  .select('*')
  .eq('status', 'active');
```

### Using Adapters

You can optionally specify an adapter for different API styles:

#### SupabaseAuthAdapter (Supabase-compatible API)

Use this adapter if you're migrating from Supabase or prefer the Supabase API style:

```typescript
import { createClient, SupabaseAuthAdapter } from '@neon/neon-js';

// `Database` is a type generated from your schema
// See "TypeScript" section below for details
const client = createClient<Database>({
  auth: {
    adapter: SupabaseAuthAdapter(),
    url: import.meta.env.VITE_NEON_AUTH_URL,
  },
  dataApi: {
    url: import.meta.env.VITE_NEON_DATA_API_URL,
  },
});

// Supabase-compatible API
await client.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'secure-password',
});

const { data: session } = await client.auth.getSession();
```

#### BetterAuthReactAdapter (React Hooks)

Use this adapter in React applications to get access to hooks like `useSession`:

```typescript
import { createClient } from '@neon/neon-js';
import { BetterAuthReactAdapter } from '@neon/neon-js/auth/react/adapters';

// `Database` is a type generated from your schema
// See "TypeScript" section below for details
const client = createClient<Database>({
  auth: {
    adapter: BetterAuthReactAdapter(),
    url: import.meta.env.VITE_NEON_AUTH_URL,
  },
  dataApi: {
    url: import.meta.env.VITE_NEON_DATA_API_URL,
  },
});

// Use in React components
function MyComponent() {
  const session = client.auth.useSession();

  if (session.isPending) return <div>Loading...</div>;
  if (!session.data) return <div>Not logged in</div>;

  return <div>Hello, {session.data.user.name}</div>;
}
```

### Anonymous Access

Enable `allowAnonymous` to let unauthenticated users query data. This uses an anonymous token for RLS-based access control:

```typescript
import { createClient } from '@neon/neon-js';

const client = createClient<Database>({
  auth: {
    url: import.meta.env.VITE_NEON_AUTH_URL,
    allowAnonymous: true, // Enable anonymous data access
  },
  dataApi: {
    url: import.meta.env.VITE_NEON_DATA_API_URL,
  },
});

// Works without signing in - uses anonymous token for RLS
const { data: publicItems } = await client.from('public_items').select();
```

### External Auth Provider

If your app authenticates with its own identity provider (Clerk, Auth0, and others) instead of Neon Auth, omit the `auth` block and pass a `getToken` function on `dataApi`. It is called lazily on every request and its JWT is attached to each Data API call — Neon validates it against the JWKS URL you configured for the provider.

```typescript
import { createClient } from '@neon/neon-js';

const neon = createClient<Database>({
  dataApi: {
    url: import.meta.env.VITE_NEON_DATA_API_URL,
    // Return a valid JWT from your provider, e.g. Clerk's getToken()
    // or Auth0's getAccessTokenSilently().
    getToken: async () => await yourAuthProvider.getToken(),
  },
});

// Every request carries your provider's token, so RLS policies apply
const { data: items } = await neon.from('items').select();
```

This form returns a `NeonPostgrestClient` — the same query API as above, without the `.auth` namespace (auth is handled by your provider). No `@neon/postgrest-js` import is needed.

## Authentication

### Sign Up

```typescript
await client.auth.signUp.email({
  email: 'user@example.com',
  password: 'secure-password',
  name: 'John Doe',
});
```

### Sign In

```typescript
// Email & Password
await client.auth.signIn.email({
  email: 'user@example.com',
  password: 'secure-password',
});

// OAuth
await client.auth.signIn.social({
  provider: 'google',
  callbackURL: '/dashboard',
});
```

### Session Management

```typescript
// Get current session
const session = await client.auth.getSession();

// Sign out
await client.auth.signOut();
```

### SupabaseAuthAdapter API

When using `SupabaseAuthAdapter`, you get access to the Supabase-compatible API:

```typescript
// Sign up with metadata
await client.auth.signUp({
  email: 'user@example.com',
  password: 'secure-password',
  options: {
    data: { name: 'John Doe' },
  },
});

// Sign in
await client.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'secure-password',
});

// OAuth
await client.auth.signInWithOAuth({
  provider: 'google',
  options: { redirectTo: '/dashboard' },
});

// Session with data wrapper
const { data: session } = await client.auth.getSession();
const { data: user } = await client.auth.getUser();

// Auth state changes
client.auth.onAuthStateChange((event, session) => {
  console.log(event, session);
});
```

## Database Querying

### SELECT Queries

```typescript
// Simple select
const { data } = await client
  .from('users')
  .select('id, name, email');

// With filters
const { data } = await client
  .from('posts')
  .select('*')
  .eq('status', 'published')
  .gt('views', 100)
  .order('created_at', { ascending: false })
  .limit(10);

// Joins
const { data } = await client
  .from('posts')
  .select(`
    id,
    title,
    author:users(name, email)
  `)
  .eq('status', 'published');
```

### INSERT Queries

```typescript
// Insert single row
const { data } = await client
  .from('users')
  .insert({
    name: 'Alice',
    email: 'alice@example.com',
  })
  .select();

// Insert multiple rows
const { data } = await client
  .from('users')
  .insert([
    { name: 'Bob', email: 'bob@example.com' },
    { name: 'Carol', email: 'carol@example.com' },
  ])
  .select();
```

### UPDATE Queries

```typescript
const { data } = await client
  .from('users')
  .update({ status: 'inactive' })
  .eq('last_login', null)
  .select();
```

### DELETE Queries

```typescript
const { data } = await client
  .from('users')
  .delete()
  .eq('status', 'deleted')
  .select();
```

### RPC (Stored Procedures)

```typescript
const { data } = await client
  .rpc('get_user_stats', {
    user_id: 123,
    start_date: '2024-01-01',
  });
```

## Configuration

### Client Options

```typescript
import { createClient } from '@neon/neon-js';

const client = createClient({
  // Auth configuration
  auth: {
    url: 'https://your-auth-server.neon.tech/auth',
    allowAnonymous: true, // Optional: enable anonymous data access
  },

  // Data API configuration
  dataApi: {
    url: 'https://your-data-api.neon.tech/rest/v1',
    options: {
      db: {
        schema: 'public', // Default schema
      },
      global: {
        headers: {
          'X-Custom-Header': 'value',
        },
      },
    },
  },
});
```

### Environment Variables

```bash
# Auth URL
NEON_AUTH_URL=https://your-auth-server.neon.tech/auth

# Data API URL
NEON_DATA_API_URL=https://your-data-api.neon.tech/rest/v1
```

```typescript
import { createClient } from '@neon/neon-js';

const client = createClient({
  auth: {
    url: process.env.NEON_AUTH_URL!,
  },
  dataApi: {
    url: process.env.NEON_DATA_API_URL!,
  },
});
```

## TypeScript

Pass a `Database` type generated from your schema to `createClient` for full type safety:

```typescript
import type { Database } from './types/database';
import { createClient } from '@neon/neon-js';

const client = createClient<Database>({
  auth: {
    url: process.env.NEON_AUTH_URL!,
  },
  dataApi: {
    url: process.env.NEON_DATA_API_URL!,
  },
});

// Fully typed queries!
const { data } = await client
  .from('users') // Autocomplete for table names
  .select('id, name, email') // Autocomplete for column names
  .eq('status', 'active'); // Type checking for values
```

## Performance

### Session Caching

Sessions are cached in memory with intelligent TTL:
- **Cold start:** ~200ms (single network request)
- **Cached reads:** <1ms (in-memory, no I/O)
- **Cache TTL:** 60 seconds or until JWT expires
- **Smart expiration:** Automatic based on JWT claims

### Request Deduplication

Concurrent authentication calls are automatically deduplicated:
- **Without deduplication:** 10 concurrent calls = 10 requests (~2000ms)
- **With deduplication:** 10 concurrent calls = 1 request (~200ms)
- **Result:** 10x faster, N-1 fewer server requests

## Environment Compatibility

- **Node.js** 20.19+
- **Browser** (all modern browsers)
- **Edge Runtime** (Vercel, Cloudflare Workers, Deno, etc.)
- **Bun** (native support)

## Error Handling

```typescript
import { AuthError } from '@neon/neon-js/auth';

// Auth errors (SupabaseAuthAdapter)
try {
  await client.auth.signInWithPassword({ email, password });
} catch (error) {
  if (error instanceof AuthError) {
    console.error('Auth error:', error.message);
  }
}

// Database errors
const { data, error } = await client.from('users').select();
if (error) {
  console.error('Database error:', error.message);
}
```

## Examples

### Next.js App Router

```typescript
// app/lib/neon.ts
import { createClient } from '@neon/neon-js';

export const neon = createClient({
  auth: {
    url: process.env.NEON_AUTH_URL!,
  },
  dataApi: {
    url: process.env.NEON_DATA_API_URL!,
  },
});

// app/api/users/route.ts
import { neon } from '@/lib/neon';

export async function GET() {
  const { data: users } = await neon.from('users').select('*');
  return Response.json(users);
}
```

### React Hook with BetterAuthReactAdapter

```typescript
import { createClient } from '@neon/neon-js';
import { BetterAuthReactAdapter } from '@neon/neon-js/auth/react/adapters';

const client = createClient({
  auth: {
    adapter: BetterAuthReactAdapter(),
    url: process.env.NEXT_PUBLIC_NEON_AUTH_URL!,
  },
  dataApi: {
    url: process.env.NEXT_PUBLIC_NEON_DATA_API_URL!,
  },
});

export function useAuth() {
  const session = client.auth.useSession();

  return {
    user: session.data?.user ?? null,
    isPending: session.isPending,
    signIn: (email: string, password: string) =>
      client.auth.signIn.email({ email, password }),
    signOut: () => client.auth.signOut(),
  };
}
```

## Supabase Migration Guide

neon-js provides a Supabase-compatible API, making migration straightforward.

### 1. Update Dependencies

```diff
- "@supabase/supabase-js": "^2.74.0"
+ "@neon/neon-js": "^0.8.0"
```

### 2. Update Environment Variables

```diff
- VITE_SUPABASE_URL="https://xxx.supabase.co"
- VITE_SUPABASE_ANON_KEY="..."
+ VITE_NEON_DATA_API_URL="https://xxx.neon.tech/neondb/rest/v1"
+ VITE_NEON_AUTH_URL="https://your-auth-server.com"
```

### 3. Update Client Initialization

```diff
- import { createClient } from '@supabase/supabase-js';
+ import { createClient, SupabaseAuthAdapter } from '@neon/neon-js';

- export const client = createClient(
-   import.meta.env.VITE_SUPABASE_URL,
-   import.meta.env.VITE_SUPABASE_ANON_KEY
- );
+ export const client = createClient<Database>({
+   auth: {
+     adapter: SupabaseAuthAdapter(), // Must call as function!
+     url: import.meta.env.VITE_NEON_AUTH_URL,
+   },
+   dataApi: {
+     url: import.meta.env.VITE_NEON_DATA_API_URL,
+   },
+ });
```

### 4. No Code Changes Needed

All authentication methods work the same:

```typescript
// These work identically
await client.auth.signInWithPassword({ email, password });
await client.auth.signUp({ email, password });
const { data: session } = await client.auth.getSession();
client.auth.onAuthStateChange((event, session) => { /* ... */ });
```

All database queries work the same:

```typescript
// These work identically
const { data } = await client.from('items').select();
await client.from('items').insert({ name: 'New Item' });
await client.from('items').update({ status: 'done' }).eq('id', 1);
await client.from('items').delete().eq('id', 1);
```

See the [todo-guardian-pro migration PR](https://github.com/pffigueiredo/todo-guardian-pro/pull/1) for a complete migration example.

## Related Packages

This package combines two underlying packages:

- [`@neon/auth`](../auth) - Authentication adapters (can be used standalone)
- [`@neon/postgrest-js`](../postgrest-js) - PostgreSQL client (can be used standalone)

## Resources

- [Neon Documentation](https://neon.com/docs)
- [Neon Auth Documentation](https://neon.com/docs/neon-auth)
- [Better Auth Documentation](https://www.better-auth.com/docs)
- [PostgREST Documentation](https://postgrest.org)

## Support

- [GitHub Issues](https://github.com/neondatabase/neon-pkgs/issues)
- [Neon Community Discord](https://discord.gg/H24eC2UN)

## License

Apache-2.0
