# @neondatabase/vite-plugin-postgres

## 0.8.2

### Patch Changes

- vite-plugin-neon-new@0.9.1

## 0.8.1

### Patch Changes

- Updated dependencies
  - vite-plugin-neon-new@0.9.0

## 0.8.0

### Minor Changes

- 2e7957d: Rename packages: get-db is now neon-new, vite-plugin-db is now vite-plugin-neon-new. The old package names continue to work but are deprecated and will show warnings. Please update your dependencies to use the new package names.

### Patch Changes

- Updated dependencies [2e7957d]
  - vite-plugin-neon-new@0.8.0

## 0.7.0

### Minor Changes

- 3d7aae9: Move app URL to `pg.new`

### Patch Changes

- Updated dependencies [02444f4]
- Updated dependencies [3d7aae9]
  - vite-plugin-db@0.7.0

## 0.6.1

### Patch Changes

- 52537ed: Fix Node.js v24 compatibility by updating engine requirement from `"22"` to `">=22"`
- Updated dependencies [52537ed]
  - vite-plugin-db@0.6.1

## 0.6.0

### Minor Changes

- f1a4a03: BREAKING: Use pooler connection string by default
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
- Updated dependencies [19e3044]
- Updated dependencies [0b3f9c4]
  - vite-plugin-db@0.6.0

## 0.5.0

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
  - vite-plugin-db@0.5.0

## 0.4.5

### Patch Changes

- 52a24df: The referrer flag is important for the **Instagres Affiliates Program**.
  People building templates or spinning apps that connect to an Instagres db can receive payouts based on their usage.

  ***

  This PR adds back support to the `--ref` / `-ref` flag to the CLI. And ensures encoding is properly done.
  It also adds thorough test coverage to this functionality to ensure payouts land without fault.

- Updated dependencies [52a24df]
  - vite-plugin-db@0.4.5

## 0.4.4

### Patch Changes

- 65e1130: Rename variables to Instagres related names
- Updated dependencies [65e1130]
  - vite-plugin-db@0.4.4

## 0.4.3

### Patch Changes

- d91f813: Refactor: Rename `instantNeon` to `instantPostgres`.
  Fix: allow `instantPostgres` to receive no parameters.
- Updated dependencies [d91f813]
  - vite-plugin-db@0.4.3

## 0.4.2

### Patch Changes

- vite-plugin-db@0.4.2

## 0.4.1

### Patch Changes

- vite-plugin-db@0.4.1

## 0.4.0

### Minor Changes

- 759488b: New minor release for deprecation logs and new names

### Patch Changes

- Updated dependencies [759488b]
  - vite-plugin-db@0.4.0
