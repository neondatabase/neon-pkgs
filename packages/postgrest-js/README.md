# @neon/postgrest-js

[![npm version](https://img.shields.io/npm/v/@neon/postgrest-js.svg)](https://www.npmjs.com/package/@neon/postgrest-js)
[![npm downloads](https://img.shields.io/npm/dm/@neon/postgrest-js.svg)](https://www.npmjs.com/package/@neon/postgrest-js)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/@neon/postgrest-js.svg)](https://github.com/neondatabase/neon-pkgs/blob/main/LICENSE)

Generic PostgreSQL client for Neon Data API without built-in authentication.

## Overview

`@neon/postgrest-js` provides a lightweight PostgreSQL client for querying Neon databases without requiring Neon Auth integration. It's ideal for scenarios where:

- Authentication is handled externally (e.g., API keys, custom auth providers)
- You want to bring your own token management
- You need a minimal client without auth dependencies

For auth-integrated clients, use [`@neondatabase/neon-js`](https://github.com/neondatabase/neon-js/tree/main/packages/neon-js) instead.

## Installation

```bash
npm install @neon/postgrest-js
# or
bun add @neon/postgrest-js
```

## Usage

### Basic Client

```typescript
import { NeonPostgrestClient } from '@neon/postgrest-js';

const client = new NeonPostgrestClient({
  dataApiUrl: 'https://ep-xxx.apirest.region.aws.neon.build/dbname/rest/v1',
  options: {
    global: {
      headers: {
        'Authorization': 'Bearer YOUR_API_KEY',
      },
    },
    db: {
      schema: 'public',
    },
  },
});

// Query your database
const { data, error } = await client
  .from('users')
  .select('*')
  .eq('status', 'active');
```

### With Token Provider

Use `fetchWithToken()` for dynamic token resolution:

```typescript
import { NeonPostgrestClient, fetchWithToken } from '@neon/postgrest-js';

// Your token provider function
const getToken = async () => {
  // Fetch from your auth system, environment, etc.
  return process.env.DATABASE_TOKEN;
};

const client = new NeonPostgrestClient({
  dataApiUrl: 'https://ep-xxx.apirest.region.aws.neon.build/dbname/rest/v1',
  options: {
    global: {
      fetch: fetchWithToken(getToken),
    },
  },
});

// Automatically injects token on every request
const { data } = await client.from('posts').select();
```

### Custom Fetch Implementation

```typescript
import { NeonPostgrestClient, fetchWithToken } from '@neon/postgrest-js';

const customFetch: typeof fetch = async (input, init) => {
  console.log('Making request:', input);
  return fetch(input, init);
};

const client = new NeonPostgrestClient({
  dataApiUrl: 'https://ep-xxx.apirest.region.aws.neon.build/dbname/rest/v1',
  options: {
    global: {
      fetch: fetchWithToken(getToken, customFetch),
    },
  },
});
```

## API Reference

### `NeonPostgrestClient`

Extends the upstream `PostgrestClient` with Neon-specific configuration.

**Constructor Options:**

```typescript
type NeonPostgrestClientConstructorOptions<SchemaName> = {
  dataApiUrl: string;
  options?: {
    db?: {
      schema?: SchemaName; // Database schema (default: 'public')
    };
    global?: {
      fetch?: typeof fetch; // Custom fetch implementation
      headers?: Record<string, string>; // Global headers
    };
  };
};
```

**Example:**

```typescript
const client = new NeonPostgrestClient({
  dataApiUrl: 'https://your-api-url.com/rest/v1',
  options: {
    db: { schema: 'public' },
    global: {
      headers: { 'X-Custom-Header': 'value' },
    },
  },
});
```

### `fetchWithToken()`

Generic fetch wrapper that injects authentication tokens.

**Signature:**

```typescript
function fetchWithToken(
  getAccessToken: () => Promise<string | null>,
  customFetch?: typeof fetch
): typeof fetch
```

**Parameters:**
- `getAccessToken`: Async function that returns the current access token
- `customFetch`: Optional custom fetch implementation (default: global `fetch`)

**Returns:** Wrapped fetch function that automatically adds `Authorization: Bearer <token>` header

**Throws:** `AuthRequiredError` if `getAccessToken()` returns `null`

**Example:**

```typescript
const authFetch = fetchWithToken(async () => {
  return await getTokenFromYourAuthSystem();
});

// Use with client
const client = new NeonPostgrestClient({
  dataApiUrl: 'https://api.example.com',
  options: { global: { fetch: authFetch } },
});
```

### `AuthRequiredError`

Error thrown when a request requires authentication but no token is available.

```typescript
class AuthRequiredError extends Error {
  constructor(message?: string);
}
```

**Usage:**

```typescript
import { AuthRequiredError } from '@neon/postgrest-js';

try {
  await client.from('users').select();
} catch (error) {
  if (error instanceof AuthRequiredError) {
    console.error('Authentication required');
  }
}
```

## Querying

All PostgrestClient query methods are available:

```typescript
// SELECT
const { data } = await client
  .from('users')
  .select('id, name, email')
  .eq('status', 'active')
  .order('created_at', { ascending: false })
  .limit(10);

// INSERT
const { data } = await client
  .from('users')
  .insert({ name: 'Alice', email: 'alice@example.com' })
  .select();

// UPDATE
const { data } = await client
  .from('users')
  .update({ status: 'inactive' })
  .eq('id', 123);

// DELETE
const { data } = await client
  .from('users')
  .delete()
  .eq('id', 123);

// RPC (stored procedures)
const { data } = await client
  .rpc('get_user_stats', { user_id: 123 });
```

## Environment Compatibility

Works in both browser and Node.js environments:

- **Browser**: Full fetch API support
- **Node.js**: Works with Node.js 18+ native fetch or polyfills

## TypeScript

Full TypeScript support with generic database types:

```typescript
interface Database {
  public: {
    users: {
      Row: { id: number; name: string; email: string };
      Insert: { name: string; email: string };
      Update: { name?: string; email?: string };
    };
  };
}

const client = new NeonPostgrestClient<Database>({
  dataApiUrl: 'https://api.example.com',
});

// Fully typed!
const { data } = await client.from('users').select();
```

## Related Packages

- [`@neondatabase/neon-js`](https://github.com/neondatabase/neon-js/tree/main/packages/neon-js) - Full SDK with Neon Auth integration
- [`@neon/auth`](../auth) - Standalone auth adapters

## Support

- [GitHub Issues](https://github.com/neondatabase/neon-pkgs/issues)
- [Neon Community Discord](https://discord.gg/H24eC2UN)

## License

Apache-2.0
