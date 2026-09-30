# Neon Live React optimistic UI example

This todo application demonstrates how to combine `@neon/live-react` with
React's `useOptimistic()` and `useActionState()` APIs. Inserts, status changes,
and deletes appear immediately in the tab where they happen. The action stays
pending until `utils.awaitTxId()` confirms that the authoritative change has
arrived through Neon Live; other tabs update from that live change.

The example includes a small Node.js API that authorizes the live query and
performs mutations. It intentionally does not include a local Docker stack or
Neon Live proxy image.

## Prerequisites

- Node.js 22 or newer and pnpm 10.30.3.
- A Neon database with Neon Live enabled.
- The database connection string, Neon Live secret, and public Neon Live
  WebSocket endpoint for that project.

The authorization and mutation endpoints are deliberately unauthenticated to
keep the example focused. Authenticate both endpoints in a real application.

## Configure the example

From the repository root, install the workspace and build the three packages
used by the example:

```shell
pnpm install
pnpm --filter @neon/live --filter @neon/live-react --filter @neon/live-drizzle build
```

Then copy the environment template:

```shell
cd examples/neon-live-react
cp .env.example .env
```

Set these values in `.env`:

- `DATABASE_URL`: connection string for the database observed by Neon Live.
- `NEON_LIVE_SECRET`: server-only secret used to authorize live queries.
- `NEON_LIVE_DATABASE`: database name from `DATABASE_URL`, such as `neondb`.
- `VITE_NEON_LIVE_URL`: public Neon Live WebSocket endpoint. This value is
  exposed to the browser; the secret is not.

## Run the example

Create the todo table and start the API and Vite development server:

```shell
pnpm db:setup
pnpm dev
```

Open <http://localhost:5173> in two tabs. Adding, completing, or deleting a
todo updates the initiating tab optimistically and the other tab through Neon
Live.

The table setup uses `REPLICA IDENTITY FULL`, which lets updates and deletes
carry the row information required by the live query.
