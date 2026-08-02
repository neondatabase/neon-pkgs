# neondb

## 0.14.2

### Patch Changes

- Updated dependencies [b8217bc]
  - neon-new@0.15.1

## 0.14.1

### Patch Changes

- Updated dependencies
  - neon-new@0.15.0

## 0.14.0

### Minor Changes

- 2e7957d: Rename packages: get-db is now neon-new, vite-plugin-db is now vite-plugin-neon-new. The old package names continue to work but are deprecated and will show warnings. Please update your dependencies to use the new package names.

### Patch Changes

- Updated dependencies [2e7957d]
  - neon-new@0.14.0

## 0.13.0

### Minor Changes

- 3d7aae9: Move app URL to `pg.new`

### Patch Changes

- Updated dependencies [02444f4]
- Updated dependencies [3d7aae9]
  - get-db@0.13.0

## 0.12.1

### Patch Changes

- 52537ed: Fix Node.js v24 compatibility by updating engine requirement from `"22"` to `">=22"`
- Updated dependencies [52537ed]
  - get-db@0.12.1

## 0.12.0

### Minor Changes

- f1a4a03: BREAKING: Use pooler connection string by default
- e215940: Suppress logs when running non-interactive mode
- 19e3044: Add support for logical replication configuration via `logicalReplication` parameter
- 0b3f9c4: **BREAKING CHANGE**: `referrer` parameter is now required for SDK/library and Vite plugin usage. CLI usage is unchanged and maintains default value.

  ## Breaking Changes

  - **SDK/Library (get-db)**: The `referrer` parameter in `instantPostgres()` is now required
  - **Vite Plugin (vite-plugin-db)**: The `referrer` option in plugin configuration is now required
  - **CLI**: No changes - the `--ref` flag remains optional with default value `npm:get-db/cli`

  ## Migration Guide

  ### For SDK/Library Users

  ```typescript
  // Before
  await instantPostgres({ dotEnvFile: ".env" });

  // Now
  await instantPostgres({
    referrer: "npm:your-package-name", // REQUIRED
    dotEnvFile: ".env",
  });
  ```

  ### For Vite Plugin Users

  ```typescript
  // Before
  postgres();

  // Now
  postgres({ referrer: "github:username/repo-name" }); // REQUIRED
  ```

  ### For CLI Users

  ✅ No changes needed - the CLI still has a default referrer value.

  ## Why This Change

  The `referrer` parameter is essential for tracking in the Instagres Affiliates Program. By requiring it for SDK and plugin users (who integrate get-db into their own tools), we ensure accurate attribution while maintaining convenience for direct CLI users.

### Patch Changes

- Updated dependencies [f1a4a03]
- Updated dependencies [e215940]
- Updated dependencies [19e3044]
- Updated dependencies [0b3f9c4]
  - get-db@0.12.0

## 0.11.0

### Minor Changes

- 0b91135: **Make pooler the default connection**

  this change may be perceived as breaking change for some, but it aligns to best practices for Neon databases.

  In prior releases, we wrote the following 3 variables to the env file:

  | Variable                     | Description                      |
  | ---------------------------- | -------------------------------- |
  | `DATABASE_URL`               | the **direct** connection string |
  | `DATABASE_URL_POOLER`        | the pooler connection string     |
  | `PUBLIC_INSTAGRES_CLAIM_URL` | the url to be claimed            |

  From this release onwards, we're aligning on using the **pooler connection string as the default**.

  | Variable                     | Description                      |
  | ---------------------------- | -------------------------------- |
  | `DATABASE_URL`               | the **pooler** connection string |
  | `DATABASE_URL_DIRECT`        | the direct connection string     |
  | `PUBLIC_INSTAGRES_CLAIM_URL` | the url to be claimed            |

### Patch Changes

- Updated dependencies [0b91135]
  - get-db@0.11.0

## 0.10.0

### Minor Changes

- 52a24df: The referrer flag is important for the **Instagres Affiliates Program**.
  People building templates or spinning apps that connect to an Instagres db can receive payouts based on their usage.

  ***

  This PR adds back support to the `--ref` / `-ref` flag to the CLI. And ensures encoding is properly done.
  It also adds thorough test coverage to this functionality to ensure payouts land without fault.

### Patch Changes

- Updated dependencies [52a24df]
  - get-db@0.10.0

## 0.9.4

### Patch Changes

- 65e1130: Rename variables to Instagres related names
- Updated dependencies [65e1130]
  - get-db@0.9.4

## 0.9.3

### Patch Changes

- d91f813: Refactor: Rename `instantNeon` to `instantPostgres`.
  Fix: allow `instantPostgres` to receive no parameters.
- d9e78d5: Rename `instantNeon` to `instantPostgres`
  Add root export `import { instantPostgres } from 'get-db'`
  Rename type `InstantNeonParams` to `InstantPostgresParams`
- Updated dependencies [d91f813]
- Updated dependencies [d9e78d5]
  - get-db@0.9.3

## 0.9.2

### Patch Changes

- 7b894b4: **Add URL detection to `claim` command**

  `get-db claim` command was unable to detect URLs for custom env_var prefixes.
  Now it accepts an override via the feature-flag, but it will also try to automatically detect the URL if it can't find the default prefix easily.

- Updated dependencies [7b894b4]
  - get-db@0.9.2

## 0.9.1

### Patch Changes

- 390b2ac: update feedback message so it says `get-db` instead of `neondb`
- Updated dependencies [390b2ac]
  - get-db@0.9.1

## 0.9.0

### Minor Changes

- 759488b: New minor release for deprecation logs and new names

### Patch Changes

- Updated dependencies [759488b]
  - get-db@0.9.0

## 0.8.2

### Patch Changes

- 9978eb4: Fix existing settings check.

  - Env preparation was wrongfully checking only for default variable and file name.
  - `--yes` flag was supressing other flags. Now it's possible to override promptless path.

## 0.8.1

### Patch Changes

- ba1f576: Fix bad rebase on docs

## 0.8.0

### Minor Changes

- 9ad30b8: Adds `claim` command

  - This command opens the browser in the Claim URL directly.
  - Adds a new environment variable with such Claim URL to be consumed by the client-side as well (useful for templates).

  ## neondb cli

  default is `PUBLIC_`

  ## vite-plugin-postgres

  default is `VITE_`

- 4ac5175: No more CAPTCHAs

  We have removed Cloudflare Turnstile Bot protection from our system.
  This unlocks a completely non-interactive flow to create new databases in Launchpad 🎉

### Patch Changes

- bf6ec47: Adjust messaging, add `--yes` tip on prompt

## 0.7.2

### Patch Changes

- aa69f87: Fix `--yes` flag suppressing `--seed` flag

## 0.7.1

### Patch Changes

- 6b382d1: Fix `--seed` CLI flag

  A bug was causing the `-s` flag to be ignored and the `--seed` to throw an exception (because the CLI expected `--sql` instead).

## 0.7.0

### Minor Changes

- 8ae511e: Add support for seeding a SQL script during database initialization. You can now provide a path to a SQL file that will be executed right after the database is created. Either via the prompt or with a command flag.

  | Option       | Description                                         |
  | ------------ | --------------------------------------------------- |
  | `-s, --seed` | Path to SQL file to execute after database creation |

## 0.6.3

### Patch Changes

- ce1c182: Add better referrer values for each package

## 0.6.2

### Patch Changes

- 9e8a5a4: Fix Unclaimed project Time-to-Live (TTL)

  The actual TTL of an unclaimed branch is 72 hours

## 0.6.1

### Patch Changes

- 995ad06: Fix Neon domain and add keywords to `package.json`

## 0.6.0

### Minor Changes

- b807e80: Adds validation to user input on file name and environment variable key.

  | Option     | Default        | Description               | Validation            |
  | ---------- | -------------- | ------------------------- | --------------------- |
  | dotEnvFile | ".env"         | Path to env file          | letters and `.`       |
  | dotEnvKey  | "DATABASE_URL" | Environment variable name | `SCREAMING_SNAKE_CASE |

- b807e80: Prevents creating a DB if flow is cancelled

  if the user aborts (CTRL+C), the CLI will not use the defaults and the process will be interrupted immediately.

### Patch Changes

- 31cb6f4: Remove `refferer`, `provider`, and `region` from possible CLI arguments
- adbfcc9: Fix: prevent flags from being ignored

  This release fixes a regression where `--env` and `--key` flags were being ignored and defaults would be used regardless.

## 0.5.0

### Minor Changes

- e3482a6: Fixed new lines being added in the .env file

## 0.4.1

### Patch Changes

- 91c6b5f: Remove trailing whitespace from `.env`

## 0.4.0

### Minor Changes

- e09a8c8: Improve logs

  - Generate better logs for the CLI.
  - Add proper Claim URL to the `.env`.
  - Remove excess tabs from the `.env` output.

## 0.3.1

### Patch Changes

- 11e28a5: Update endpoints

## 0.3.0

### Minor Changes

- 05de2a7: Add `/sdk` export for `instantNeon`

## 0.2.1

### Patch Changes

- a0817d9: Append the defaults to the prompt messages.
