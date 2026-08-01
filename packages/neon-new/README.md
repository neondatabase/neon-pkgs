<h1 align="center">neon-new</h1>

<p align="center">CLI to help you hit the ground running without any sign-up. Instantiate a database with a single-command!</p>

---

> **Requirements:** Node.js >= 20.19.

## CLI Usage

The CLI provides a default referrer value, so the `--ref` flag is optional.

| Package Manager | Command               |
| --------------- | --------------------- |
| **npm**         | `npx neon-new`          |
| **pnpm**        | `pnpx neon-new`         |
| **yarn**        | `yarn dlx neon-new`     |
| **bun**         | `bunx neon-new`         |
| **deno**        | `deno run npm:neon-new` |

```sh
npx neon-new [options]
```

Options:

-   `-y, --yes` Use defaults, skip prompts
-   `-e, --env` Path to .env file (default: ./.env)
-   `-k, --key` Env key for connection string (default: DATABASE_URL)
-   `-p, --prefix` Prefix for public env vars (default: PUBLIC\_)
-   `-r, --ref` Referrer identifier for tracking (default: npm:neon-new/cli)
-   `-s, --seed` Path to SQL file to execute after database creation
-   `-L, --logical-replication` Enable logical replication (default: false)
-   `-h, --help` Show help

---

## SDK/API Usage

Import the SDK:

```ts
import { instantPostgres } from "neon-new/sdk";
```

Create a claimable Lakebase Postgres database on Neon and save credentials to your .env:

```ts
await instantPostgres({
	referrer: "your-cli-package-name", // REQUIRED
	dotEnvFile: ".env",
	dotEnvKey: "DATABASE_URL",
	envPrefix: "PUBLIC_",
	settings: {
		logicalReplication: false, // Enable logical replication
	},
	// This referrer parameter helps us understand where usage comes from.
	// If you're publishing a library, we'd love that you re-expose a
	// referrer parameter in your lib and set this to `npm:your-lib-package-name|${referrer}`
	// So we can understand the chain better and give you all the credit you deserve!
});
```

| Option     | Default        | Description                        | Required | Validation            |
| ---------- | -------------- | ---------------------------------- | -------- | --------------------- |
| referrer   | -              | Referrer identifier                | Yes      | -                     |
| dotEnvFile | ".env"         | Path to env file                   | No       | letters and `.`       |
| dotEnvKey  | "DATABASE_URL" | Environment variable name          | No       | `SCREAMING_SNAKE_CASE |
| envPrefix  | "PUBLIC\_"     | Prefix for public environment vars | No       | -                     |
| settings   | -              | Database configuration settings    | No       | -                     |

### settings Options

| Property            | Type    | Description                    | Default |
| ------------------- | ------- | ------------------------------ | ------- |
| `logicalReplication`| boolean | Enable logical replication     | `false` |

> **Note**: The Vite plugin uses `VITE_` as the default `envPrefix` to match Vite's convention for client-side environment variables.

Returns:

| Property            | Description                                   |
| ------------------- | --------------------------------------------- |
| `databaseUrl`       | Pooled connection string (default connection) |
| `databaseUrlDirect` | Direct connection string                      |
| `claimUrl`          | Claim link                                    |
| `claimExpiresAt`    | Expiration date                               |

### Environment Variables Written

When you run `neon-new`, the following environment variables are written to your `.env` file:

| Variable                         | Description                                              |
| -------------------------------- | -------------------------------------------------------- |
| `DATABASE_URL`                   | The **pooler** connection string (default connection)    |
| `DATABASE_URL_DIRECT`            | The direct connection string                             |
| `{envPrefix}POSTGRES_CLAIM_URL` | Claim URL (valid for 72 hours) to take ownership of the DB |

> **Note:** The pooler connection is now the default for `DATABASE_URL` (as of the latest version). The pooler provides connection pooling and is recommended for most use cases, especially serverless environments.

---

## Types

```ts
// Params for instantPostgres
interface InstantPostgresParams {
	referrer: string; // Required
	dotEnvFile?: string;
	dotEnvKey?: string;
	envPrefix?: string;
	seed?: { type: "sql-script"; path: string };
	settings?: {
		logicalReplication?: boolean; // Enable logical replication (default: false)
	};
}
```

> See [documentation on Neon](https://neon.com/docs/reference/instagres) for more.

---

This package was templated with [`create-typescript-app`](https://github.com/JoshuaKGoldberg/create-typescript-app) using the [Bingo engine](https://create.bingo).
