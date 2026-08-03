# neonctl

## 2.40.0

### Patch Changes

- Updated dependencies [a47cf06]
  - neon@2.40.0

## 2.39.1

### Patch Changes

- neon@2.39.1

## 2.39.0

### Patch Changes

- Updated dependencies [b8217bc]
- Updated dependencies [123b57e]
  - neon@2.39.0

## 2.38.5

### Patch Changes

- neon@2.38.5

## 2.38.4

### Patch Changes

- cea030f: `neon --help` no longer prints the value of `NEON_API_KEY`.

  The global `--api-key` option took its yargs `default` from `process.env.NEON_API_KEY`, and yargs renders an option's default into every help screen it produces. With the variable exported — the normal setup in CI and in any shell that sources a `.env` — the key was printed verbatim on `neon --help` and on every subcommand's `--help`, so it reached CI logs, terminal recordings, and pasted bug reports:

  ```
  --api-key
  └────────────────>  API key [string] [default: "napi_1a2b3c…"]
  ```

  Help now names the variable instead of its value:

  ```
  --api-key
  └────────────────>  API key [string] [default: NEON_API_KEY]
  ```

  Resolution is unchanged: `--api-key` wins, `NEON_API_KEY` is used when the flag is absent, and stored credentials are used when neither is set. The environment lookup moved out of the option default into a middleware that runs after help has been rendered.

- Updated dependencies [cea030f]
  - neon@2.38.4

## 2.38.3

### Patch Changes

- neon@2.38.3

## 2.38.2

### Patch Changes

- 4ae4e1a: `neon env pull` now verifies branch credential secrets instead of trusting whatever is on disk, and `fetchEnv` becomes a pure fetch.

  Object storage and AI Gateway secrets are returned once at mint time, so resolving a branch's env reused the persisted copy rather than minting a credential per call. That reuse was presence-based, so a `.env.example` placeholder counted as a real secret: copying one and running `neonctl env pull` left the placeholders in place, reported as pulled, and produced a `.env` that did not work.

  **`fetchEnv` no longer reads any env source.** The `env` option is gone; it returns exactly what the Neon API reports, and mints a credential only when a credential-backed var is requested. It gains a `keys` filter — the same typesafe, autocompleting selection `parseEnv` accepts — and the filter skips work, not just result fields: leave out `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `NEON_AI_GATEWAY_TOKEN` and no credential is minted at all. `NEON_BRANCH` is now a selectable key. `toEntries` accepts a filtered result.

  **New `@neon/env/runtime` entry point**, holding `fetchEnvReusingSecrets(config, { projectId, branch, env })`. It owns everything stateful, outside `fetchEnv`: it verifies the persisted secrets against the branch's live credentials, keeps them only when they name one that still exists, is not revoked or expired, and carries every needed scope, and otherwise mints a replacement and revokes what it superseded. Returns `{ vars, credential }` — no callback. This needs no local bookkeeping, because `AWS_ACCESS_KEY_ID` is the credential's token id and the AI Gateway token embeds its short id, so the persisted secrets already name the credential that issued them.

  The subpath keeps the root export pure: an app or build script importing `@neon/env` is offered `fetchEnv` / `parseEnv` / `toEntries` and nothing that reads an env source or mutates credentials. Same split as `@neon/config` vs `@neon/config-runtime`.

  `neon env pull`, `neon dev`, and `neon-env run` / `export` all go through the wrapper, so all three now verify rather than trust. `env pull` reports re-issued credentials by name so you know which values changed. Also: `fetchEnv` reads a branch's storage settings before minting, so a policy declaring buckets on a branch without storage fails without having spent a credential.

- Updated dependencies [4ae4e1a]
  - neon@2.38.2

## 2.38.1

### Patch Changes

- Updated dependencies [2532f9e]
  - neon@2.38.1

## 2.38.0

### Minor Changes

- eda9d82: Make `neon` the package that carries the Neon CLI implementation, and turn `neonctl` into a lightweight compatibility package that depends on `neon` and runs its CLI entry point. `neonctl` keeps providing both the `neonctl` and `neon` commands, so installing it — including via Homebrew — behaves exactly as before, and now also downloads `neon`.

### Patch Changes

- Updated dependencies [eda9d82]
  - neon@2.38.0
