# neonctl

## 2.30.1

### Patch Changes

- d511ca4: Adapt the API layer to `@neon/sdk@1.0.0`'s unified raw contract: raw calls now resolve to
  `{ data, error }` with a typed `NeonError`, and the CLI unwraps the error body accordingly.
  No user-facing behavior change.
- Updated dependencies [9b2794e]
- Updated dependencies [d511ca4]
  - @neon/sdk@1.0.0
  - @neon/config@0.9.1
  - @neon/config-runtime@0.9.1
  - @neon/env@0.10.1

## 2.30.0

### Minor Changes

- Add `neon api <path>`, a passthrough command for calling any Neon API route directly from the CLI. It reuses your existing authentication, so requests are automatically authorized, and maps flags to the request: `-X/--method`, `-F/--field` (typed, dot-notation nested body), `-f/--raw-field`, `-d/--data` (`@file`/stdin/JSON), `-Q/--query`, `-H/--header`, and `-i/--include`. Run `neon api --list` to browse every available endpoint from the Neon OpenAPI spec. Because request mode calls the API directly, newly added or updated endpoints work immediately.

## 2.29.3

### Patch Changes

- Support Node.js >= 20.19 for the CLI. Bump `engines.node` from `>=20.18.1` to `>=20.19.0`
  (matching `chokidar@5`) and upgrade the pinned `neon-init` dependency to `0.20.0`, which now
  declares `engines.node: ">=20.19.0"` — this removes the `EBADENGINE`/`>=22` install warning that
  `neonctl` previously surfaced on Node 20 via the older `neon-init`.

## 2.29.2

### Patch Changes

- Lower the Node requirement from `>=22` back to `>=20.18.1` by pinning `undici` to `^7.28.0` (undici 8 requires Node 22.19+). undici is only used for `HTTP(S)_PROXY` support via `EnvHttpProxyAgent`, which is available in undici 7, so there is no behavioral change — this just restores Node 20 compatibility for the CLI.

## 2.29.1

### Patch Changes

- Updated dependencies [b78ced2]
  - @neon/env@0.9.0

## 2.29.0

### Minor Changes

- Add `neon config init`: scaffold a starter `neon.ts` policy and install the Neon config packages (`@neon/config` + `@neon/env`), detecting the project's package manager. Also offer it as the final step of an interactive `neon link` (then pull env so the local `.env` reflects the new policy).

## 2.28.0

### Minor Changes

- f13ce14: Add `neon status` and the `--current-branch` flag for `config status`.

  `neon status` is a top-level alias for `neon config status` (it mirrors all of its options and delegates to the same handler).

  `config status --current-branch` (also `neon status --current-branch`) prints only the branch pinned in the local `.neon` file with no network request, no login, and no analytics — cheap enough to drive a shell prompt (e.g. starship). It prints the branch name to stdout and exits 0; when no branch is pinned it prints nothing to stdout, writes a `neonctl checkout <branch>` hint to stderr, and exits non-zero (grep-style) so a prompt can guard on the command directly.

### Patch Changes

- Migrate neonctl off the deprecated axios-based `@neondatabase/api-client` to a fetch-native client over `@neon/sdk`. `axios` and `axios-debug-log` are removed; API failures now surface as a single `NeonApiError`; `HTTP(S)_PROXY` / `NO_PROXY` support is preserved (via undici) and the per-request timeout + 423 retry are unchanged. Also bumps the bundled `@neondatabase/config`, `@neondatabase/config-runtime`, and `@neondatabase/env` to 0.8.1 (the @neon/sdk-based releases). Requires Node >=22.

## 2.27.1

### Patch Changes

- 68a080f: Republish `neonctl` from the `neon-pkgs` monorepo (`packages/cli`). The CLI source has moved from `neondatabase/neonctl`; no functional changes.

## 2.27.0

### Moved into the monorepo

- Migrated the Neon CLI source from [`neondatabase/neonctl`](https://github.com/neondatabase/neonctl) into `neon-pkgs` as `packages/cli`. No functional changes — still published as `neonctl` with the `neonctl` and `neon` binaries.
