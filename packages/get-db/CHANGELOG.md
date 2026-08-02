# get-db

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

- 02444f4: Fix SQL seed parsing to handle dollar-quoted functions and other Postgres syntax.

## 0.12.1

### Patch Changes

- 52537ed: Fix Node.js v24 compatibility by updating engine requirement from `"22"` to `">=22"`

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

## 0.10.0

### Minor Changes

- 52a24df: The referrer flag is important for the **Instagres Affiliates Program**.
  People building templates or spinning apps that connect to an Instagres db can receive payouts based on their usage.

  ***

  This PR adds back support to the `--ref` / `-ref` flag to the CLI. And ensures encoding is properly done.
  It also adds thorough test coverage to this functionality to ensure payouts land without fault.

## 0.9.4

### Patch Changes

- 65e1130: Rename variables to Instagres related names

## 0.9.3

### Patch Changes

- d91f813: Refactor: Rename `instantNeon` to `instantPostgres`.
  Fix: allow `instantPostgres` to receive no parameters.
- d9e78d5: Rename `instantNeon` to `instantPostgres`
  Add root export `import { instantPostgres } from 'get-db'`
  Rename type `InstantNeonParams` to `InstantPostgresParams`

## 0.9.2

### Patch Changes

- 7b894b4: **Add URL detection to `claim` command**

  `get-db claim` command was unable to detect URLs for custom env_var prefixes.
  Now it accepts an override via the feature-flag, but it will also try to automatically detect the URL if it can't find the default prefix easily.

## 0.9.1

### Patch Changes

- 390b2ac: update feedback message so it says `get-db` instead of `neondb`

## 0.9.0

### Minor Changes

- 759488b: New minor release for deprecation logs and new names
