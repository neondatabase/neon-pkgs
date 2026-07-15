# neonctl

## 2.33.1

### Patch Changes

- Updated dependencies [3abe4f7]
  - @neon/config@0.9.4
  - neon-init@0.20.2
  - @neon/config-runtime@0.9.4
  - @neon/env@0.11.3

## 2.33.0

### Minor Changes

- Surface AI Gateway plan and model-catalog limits in the `neon.ts` lifecycle and `env pull`. Enabling `preview.aiGateway` is credential-gated, but the gateway only serves on a paid plan, so `neon config apply` / `deploy` and `neon checkout` now refuse to provision it on the Free plan with a friendly upgrade message (org-scoped Console billing link), while `neon config plan` (dry run) and `neon env pull` only warn. On a paid plan, `neon env pull` checks the branch's `/v1/models` and, when the catalog is reduced, links the branch's Console AI Gateway page to request access to more models.

### Patch Changes

- Updated dependencies [22d5cdd]
  - neon-init@0.20.1
  - @neon/env@0.11.2
  - @neon/config@0.9.3
  - @neon/sdk@1.1.1
  - @neon/config-runtime@0.9.3

## 2.32.0

### Minor Changes

- fe98464: `neon config plan` / `apply` (and `deploy`) now render their output as a git-style diff instead of tables. Service changes (Neon Auth, Data API, buckets, functions) list as green `+` additions; branch setting changes (TTL, `protected`, compute) group under a `~ <branch>` header as sorted `field → value` lines. A bare `apply` that hits drift on settings already present remotely now prints those as a sorted before→after diff (`current → desired`, old in red / new in green) — matching the `neon diff` styling — before exiting non-zero with the `--update-existing` hint. Colors honor `--no-color` and non-TTY pipes; `--output json|yaml` is unchanged.
- 5cfbf6a: Add a top-level `neon diff [compare-branch]` command that prints a git-style schema diff between the branch you're on (pinned in `.neon`, or `--branch`) and another branch. Omitting the argument compares the current branch against its parent ("what did I change since branching?"). Supports `--database`/`--db` to scope to one database (all databases by default), `--output json|yaml` for a structured per-database result, and colorized `git diff`-style output (red `---` / green `+++` / cyan `@@`, honoring `--no-color` and non-TTY pipes). The summary goes to stderr and the diff body to stdout, so `neon diff main > changes.patch` captures just the diff. For history-aware comparisons (a branch against its own past state at a timestamp/LSN), continue to use `branches schema-diff`.

## 2.31.1

### Patch Changes

- Updated dependencies [dba7d3f]
  - @neon/sdk@1.1.0
  - @neon/config@0.9.2
  - @neon/config-runtime@0.9.2
  - @neon/env@0.11.1

## 2.31.0

### Minor Changes

- 3ad35b3: AI Gateway env is now exposed only under its Neon-branded vars. `preview.aiGateway` no longer emits the OpenAI SDK aliases `OPENAI_API_KEY` / `OPENAI_BASE_URL` — matching the deployed Functions runtime, which only injects `NEON_AI_GATEWAY_TOKEN` / `NEON_AI_GATEWAY_BASE_URL`.

  - `fetchEnv` / `parseEnv` / `toEntries` now read and write `NEON_AI_GATEWAY_TOKEN` and `NEON_AI_GATEWAY_BASE_URL`. `env.aiGateway.apiKey` maps to the token and `env.aiGateway.baseUrl` is now the **bare** gateway host (`https://<branch>-api.ai.<region>.…`, no `/ai-gateway/openai/v1` path) — clients like `@neon/ai-sdk-provider` append the dialect routes themselves.
  - `neonctl env pull` no longer writes `OPENAI_*`, and now owns/prunes the `NEON_AI_GATEWAY_*` vars.

  Migration: if you relied on the injected `OPENAI_API_KEY` / `OPENAI_BASE_URL`, read `NEON_AI_GATEWAY_TOKEN` / `NEON_AI_GATEWAY_BASE_URL` instead (or set your own `OPENAI_*` by hand — `env pull` leaves user-set vars untouched).

- 35b75b6: Bring the embedded `psql` up to PostgreSQL 19 parity. `\d`/`\dRp`/`\dRp+`/`\dRs+` now show the new PG 19 catalog columns — publication "All sequences" (`FOR ALL SEQUENCES`), the publication `EXCEPT` list (a table's "Excluded from publications" and a sequence's "Included in publications" footers), and subscription Server / Retain dead tuples / Max retention duration / Retention active / Receiver timeout. Adds `\pset display_true` / `\pset display_false` to customize how boolean values render. All version-gated, so older servers are unaffected.

### Patch Changes

- Updated dependencies [3ad35b3]
  - @neon/env@0.11.0

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
