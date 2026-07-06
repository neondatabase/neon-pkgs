# vite-plugin-neon-new

This Vite plugin instantly provisions a Postgres instance (via Neon) and injects the connection string into your `.env` file, so you can start developing immediately.

> **Note:** This package was previously named `vite-plugin-db`. The old package is now deprecated. If you're upgrading, simply replace it with `vite-plugin-neon-new` in your imports and package.json.

## How it works

- On first `vite dev`, the plugin checks for a `DATABASE_URL` (or your configured key) in your `.env`.
- If not found, it creates a claimable Neon database and writes the connection string to your `.env`.
- The plugin is a noop in production builds.

## Installation

| Package Manager | Command                                |
| --------------- | -------------------------------------- |
| **npm**         | `npm add -D vite-plugin-neon-new`      |
| **pnpm**        | `pnpm add -D vite-plugin-neon-new`     |
| **yarn**        | `yarn add -D vite-plugin-neon-new`     |
| **bun**         | `bun add -D vite-plugin-neon-new`      |
| **deno**        | `deno add -D npm:vite-plugin-neon-new` |

> **Requirements:** Node.js >= 20.19.

## Usage

> **BREAKING CHANGE in v3.0.0**: The `referrer` option is now **required**.

Add the plugin as the first entry in your Vite config:

```ts
import { postgres } from "vite-plugin-neon-new";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		postgres({
			referrer: "github:username/repo-name", // REQUIRED
		}),
		react(),
	],
});
```

## Configuration

You can pass an options object to customize the `.env` file path, the environment variable name, and database seeding:

```ts
postgres({
	referrer: "your-app-name", // REQUIRED - for tracking and affiliates
	env: ".env.local", // Path to your .env file (default: ".env")
	envKey: "DATABASE_URL", // Name of the env variable (default: "DATABASE_URL")
	envPrefix: "VITE_", // Prefix for public env vars (default: "VITE_")
	settings: {
		logicalReplication: false, // Enable logical replication (default: false)
	},
	seed: {
		type: "sql-script",
		path: "./schema.sql", // Path to SQL file to execute after database creation
	},
});
```

| Option      | Type   | Description                             | Required | Default        |
| ----------- | ------ | --------------------------------------- | -------- | -------------- |
| `referrer`  | string | Referrer identifier for tracking        | Yes      | -              |
| `env`       | string | Path to the `.env` file                 | No       | `.env`         |
| `envKey`    | string | Name of the environment variable        | No       | `DATABASE_URL` |
| `envPrefix` | string | Prefix for public environment variables | No       | `VITE_`        |
| `settings`  | object | Database configuration settings         | No       | -              |
| `seed`      | object | Configuration for seeding the database  | No       | -              |

### settings Options

| Property             | Type    | Description                | Default |
| -------------------- | ------- | -------------------------- | ------- |
| `logicalReplication` | boolean | Enable logical replication | `false` |

### seed Options

| Property | Type   | Description                                     | Default |
| -------- | ------ | ----------------------------------------------- | ------- |
| `type`   | string | Type of seeding (currently only `"sql-script"`) | -       |
| `path`   | string | Path to SQL file to execute after creation      | -       |

## What gets written

The plugin writes the following environment variables to your `.env`:

| Variable                        | Description                                                |
| ------------------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`                  | The **pooler** connection string (default connection)      |
| `DATABASE_URL_DIRECT`           | The direct connection string                               |
| `{envPrefix}POSTGRES_CLAIM_URL` | Claim URL (valid for 72 hours) to take ownership of the DB |

> **Note:** The pooler connection is now the default for `DATABASE_URL` (as of the latest version). The pooler provides connection pooling and is recommended for most use cases, especially serverless environments.

If `seed` is configured, the specified SQL script will be executed after database creation.

## Type Definitions

```ts
interface PostgresPluginOptions {
	referrer: string; // Required - Referrer identifier for tracking
	env?: string; // Path to the .env file
	envKey?: string; // Name of the environment variable
	envPrefix?: string; // Prefix for public environment variables
	settings?: {
		logicalReplication?: boolean; // Enable logical replication (default: false)
	};
	seed?: {
		type: "sql-script";
		path: string;
	};
}
```

---

## FAQ

<details>
<summary>What if I already have a <code>DATABASE_URL</code> env var?</summary>

The plugin will not overwrite it. Remove the variable if you want to generate a new Neon database.

</details>

<details>
<summary>Is this safe to run on CI when building for production?</summary>

The plugin is a noop in production mode (`vite build`), so it won't create databases or modify your `.env` in CI.

</details>

<details>
<summary>Can I use this with other frameworks?</summary>

Yes, this plugin is framework-agnostic. The example uses React, but you can use it with any Vite-compatible framework.
</sumamry>

## Advanced

If you want to generate claimable databases outside of Vite, use the [`neon-new`](https://github.com/neondatabase/neon-pkgs/tree/main/packages/neon-new) library directly.

> See [documentation on Neon](https://neon.com/docs/reference/neon-launchpad) for more.
