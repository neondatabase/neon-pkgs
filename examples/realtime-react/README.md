# Realtime React optimistic UI example

This todo application demonstrates how to combine `@neon/realtime-react` with
React's `useOptimistic()` and `useActionState()` APIs. Inserts, status changes,
and deletes appear immediately in the tab where they happen. The action stays
pending until `utils.awaitTxId()` confirms that the authoritative change has
arrived through Realtime; other tabs update from that live change.

The example includes a small Node.js API that seals the live query and performs
mutations. It intentionally does not include a local Docker stack or Realtime
proxy image.

## Prerequisites

- Node.js 22 or newer and pnpm 10.30.3.
- A Neon database with Realtime enabled.
- The database connection string, Realtime secret, and public Realtime
  WebSocket endpoint for that project.

The query-sealing and mutation endpoints are deliberately unauthenticated to
keep the example focused. Authenticate both endpoints in a real application.

## Configure the example

From the repository root, install the workspace and build the three packages
used by the example:

```shell
pnpm install
pnpm --filter @neon/realtime --filter @neon/realtime-react \
  --filter @neon/realtime-drizzle build
```

Then copy the environment template:

```shell
cd examples/realtime-react
cp .env.example .env
```

Set these values in `.env`:

- `DATABASE_URL`: connection string for the database observed by Realtime.
- `NEON_REALTIME_SECRET`: server-only secret used to seal live queries.
- `NEON_REALTIME_DATABASE`: database name from `DATABASE_URL`, such as
  `neondb`.
- `VITE_NEON_REALTIME_URL`: public Realtime WebSocket endpoint. This value is
  exposed to the browser; the secret is not.

## Run the example

Create the todo table and start the API and Vite development server:

```shell
pnpm db:setup
pnpm dev
```

Open <http://localhost:5173> in two tabs. Adding, completing, or deleting a
todo updates the initiating tab optimistically and the other tab through
Realtime.

The table setup uses `REPLICA IDENTITY FULL`, which lets updates and deletes
carry the row information required by the live query.
