# neon

## 2.40.0

### Minor Changes

- a47cf06: `neon config init` now asks which Neon services the scaffolded `neon.ts` should declare — Managed Better Auth, Functions, Object Storage, AI Gateway — and writes them into the policy. Selecting Functions also scaffolds the `hello.ts` handler the declared function points at.

  `--services auth,functions,storage,ai-gateway` picks them without a prompt, `--services none` scaffolds the bare starter policy, and a run with no TTY (CI, an agent) keeps writing exactly the file it wrote before.

## 2.39.1

### Patch Changes

- Updated dependencies [3ade88e]
  - @neon/config@0.12.0
  - @neon/config-runtime@0.12.0
  - @neon/env@0.13.0

## 2.39.0

### Minor Changes

- 123b57e: Add `externalPackages` to a `neon.ts` function, for dependencies esbuild cannot bundle

  A function's `source` is bundled at deploy time, and some packages cannot be bundled at all: a native `.node` addon has no esbuild loader, and a library may reference an optional peer dependency on a code path the function never takes. Both fail the deploy with a resolve or loader error naming the package, and neither is fixable from the function's own source — there was no way to opt a package out.

  `externalPackages` is that escape hatch, and the deploy-time counterpart of Next.js's `serverExternalPackages`:

  ```ts
  export default defineConfig({
    preview: {
      functions: {
        agent: {
          name: "Agent",
          source: "./functions/agent.ts",
          externalPackages: ["microsandbox", "@mongodb-js/zstd"],
        },
      },
    },
  });
  ```

  Every entry is passed to esbuild's `external`, so the import survives into the bundle instead of being followed. `neon deploy`, `neon config apply`, `buildFunctionBundle`, and `neon dev` all apply the same list, so a local run bundles like a deploy.

  **An external package is not resolvable at runtime.** The deployed archive is a single `index.mjs` with no `node_modules` beside it, so anything listed here throws `Cannot find module` if the function actually reaches it. The option unblocks an import that is never evaluated; it does not make a dependency usable. A dependency the handler actually calls has to be bundled — which a pure-JavaScript package can be, and a package backed by a native `.node` binary cannot, by any bundler.

  Entries are package names, optionally with a subpath (`pkg`, `@scope/pkg`, `pkg/sub`). A relative or absolute path is rejected at validation time.

### Patch Changes

- b8217bc: Name the database Lakebase Postgres, and stop calling Neon a platform

  Copy only, no behaviour change beyond one error message string.

  - `neon`: the npm description no longer says "Neon Serverless Postgres"; the README names the primitives the CLI manages.
  - `@neon/config` and `@neon/config-runtime`: "Config-as-Code for the Neon Platform" is now "Config-as-Code for Neon", in the npm descriptions, the README, and the `v1` doc comments.
  - `@neon/config`: the validation error `Invalid Neon platform config:` is now `Invalid Neon config:`. Anything matching on that string needs updating.
  - `neon-init`: `neon-init auth` is described as "Manage Neon authentication"; the signup prompt no longer calls Neon "a serverless Postgres provider"; two bootstrap template blurbs say Lakebase Postgres.
  - `neon-new`: README says "a claimable Lakebase Postgres database on Neon" — claimable databases are Neon-only, so the access path is named.

- Updated dependencies [b8217bc]
- Updated dependencies [123b57e]
  - @neon/config@0.11.0
  - @neon/config-runtime@0.11.0
  - @neon/env@0.12.2
  - neon-init@0.20.5

## 2.38.5

### Patch Changes

- Updated dependencies [fac9ab2]
  - neon-init@0.20.4

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

## 2.38.3

### Patch Changes

- Updated dependencies [630f102]
  - @neon/sdk@1.4.0
  - @neon/config@0.10.1
  - @neon/config-runtime@0.10.1
  - @neon/env@0.12.1

## 2.38.2

### Patch Changes

- 4ae4e1a: `neon env pull` now verifies branch credential secrets instead of trusting whatever is on disk, and `fetchEnv` becomes a pure fetch.

  Object storage and AI Gateway secrets are returned once at mint time, so resolving a branch's env reused the persisted copy rather than minting a credential per call. That reuse was presence-based, so a `.env.example` placeholder counted as a real secret: copying one and running `neonctl env pull` left the placeholders in place, reported as pulled, and produced a `.env` that did not work.

  **`fetchEnv` no longer reads any env source.** The `env` option is gone; it returns exactly what the Neon API reports, and mints a credential only when a credential-backed var is requested. It gains a `keys` filter — the same typesafe, autocompleting selection `parseEnv` accepts — and the filter skips work, not just result fields: leave out `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `NEON_AI_GATEWAY_TOKEN` and no credential is minted at all. `NEON_BRANCH` is now a selectable key. `toEntries` accepts a filtered result.

  **New `@neon/env/runtime` entry point**, holding `fetchEnvReusingSecrets(config, { projectId, branch, env })`. It owns everything stateful, outside `fetchEnv`: it verifies the persisted secrets against the branch's live credentials, keeps them only when they name one that still exists, is not revoked or expired, and carries every needed scope, and otherwise mints a replacement and revokes what it superseded. Returns `{ vars, credential }` — no callback. This needs no local bookkeeping, because `AWS_ACCESS_KEY_ID` is the credential's token id and the AI Gateway token embeds its short id, so the persisted secrets already name the credential that issued them.

  The subpath keeps the root export pure: an app or build script importing `@neon/env` is offered `fetchEnv` / `parseEnv` / `toEntries` and nothing that reads an env source or mutates credentials. Same split as `@neon/config` vs `@neon/config-runtime`.

  `neon env pull`, `neon dev`, and `neon-env run` / `export` all go through the wrapper, so all three now verify rather than trust. `env pull` reports re-issued credentials by name so you know which values changed. Also: `fetchEnv` reads a branch's storage settings before minting, so a policy declaring buckets on a branch without storage fails without having spent a credential.

- Updated dependencies [4ae4e1a]
  - @neon/env@0.12.0

## 2.38.1

### Patch Changes

- 2532f9e: Stop deleting stored credentials when a 401 comes from an API key. A rejected `--api-key` or `NEON_API_KEY` no longer signs you out of the account saved in your config directory, and reports the rejection instead of retrying. When the stored OAuth token is what was rejected, it is still cleared — but now from the directory named by `--config-dir` rather than always the default one.
- Updated dependencies [54ab231]
  - neon-init@0.20.3

## 2.38.0

### Minor Changes

- eda9d82: Make `neon` the package that carries the Neon CLI implementation, and turn `neonctl` into a lightweight compatibility package that depends on `neon` and runs its CLI entry point. `neonctl` keeps providing both the `neonctl` and `neon` commands, so installing it — including via Homebrew — behaves exactly as before, and now also downloads `neon`.

## 2.37.1

### Patch Changes

- 30d42c9: Update the post-sign-in page to the current official Neon logomark, with brand light/dark fills that follow the system color scheme.

## 2.37.0

### Minor Changes

- 57461c9: Apply a `neon.ts` policy as part of creating a branch, so a rejected setting can't leave a half-configured branch behind — and keep pulled dotenv files out of git.

  `createBranch` used to create the branch and then push the policy onto it, so a setting Neon rejected (a plan-gated compute value, an out-of-range autoscaling limit) failed _after_ the branch existed: the branch stayed behind, `.neon` was never pinned, no env was pulled, and re-running `neon checkout` silently accepted the half-configured branch because checkout never reconciles a branch that already exists. Everything the policy can express in the create call — `parent`, `ttl`, `protected`, and compute settings — now rides along on it, and Neon validates the request as a whole, so a rejected value fails with no branch created and the API's own error. `result.applied` still reports those settings, described exactly like the changes a push applies, so folding them into the creation doesn't make them disappear from the summary (`neon checkout` prints them as a `parent → main` / `ttl → …` / `computeSettings.autoscalingLimitMaxCu → 2` diff).

  Services — Neon Auth, the Data API, buckets, and functions — are provisioned against an existing branch id and have no create-time equivalent, so that window stays open. It is now typed: `createBranch` throws `PartialBranchCreateError` (exported from `@neon/config` with `branchId` / `branchName` / `reason`, plus an `isPartialBranchCreateError` guard), and `neon checkout` uses it to pin the branch and pull its env before failing with the cause and both recovery paths (`neon deploy --update-existing`, or delete and check out again for a policy keyed on `!branch.exists`).

  `neon env pull` — including the pull bundled into `link` / `checkout` / `deploy` — now adds a dotenv file it creates to `.gitignore`, the same way the `.neon` context file is handled, so a live `DATABASE_URL` isn't one `git add -A` from being committed. Nothing is appended when an existing pattern such as `.env*` or `*.local` already covers the file, and a dotenv file that already existed is left alone.

### Patch Changes

- Updated dependencies [57461c9]
  - @neon/config@0.10.0
  - @neon/config-runtime@0.10.0
  - @neon/env@0.11.8

## 2.36.2

### Patch Changes

- Updated dependencies [44a95e8]
  - @neon/env@0.11.7

## 2.36.1

### Patch Changes

- `neon snapshots schedule set` now only accepts the backup frequencies the API supports (`daily`, `weekly`, `monthly`).

  - The `--frequency` flag drops `hourly` / `yearly` from its choices.
  - The `--schedule <json>` path now validates each entry's `frequency` and errors on an unsupported value (e.g. `hourly`) instead of forwarding it to the API, closing the gap where invalid frequencies bypassed the flag-level check.
  - Regenerated `--pg-version` help text from the spec (documents the Postgres 19 rollout).

- Updated dependencies
  - @neon/sdk@1.3.0
  - @neon/config@0.9.6
  - @neon/config-runtime@0.9.7
  - @neon/env@0.11.6

## 2.36.0

### Minor Changes

- Add `neon inspect db` diagnostic commands to help investigate database health, sizes, and query statistics.

## 2.35.2

### Patch Changes

- d031275: Auto-pick Neon's default `neondb` database when a branch has more than one. Previously `fetchEnv` threw as soon as a branch had multiple databases, so `neonctl link` / `neonctl env pull` failed on a branch that had `neondb` alongside another database. It now uses `neondb` when present (or the sole database otherwise); a branch with several databases and no `neondb` still throws so the choice is never made randomly — rename one to `neondb` or keep a single database (or pass `databaseName` when calling `fetchEnv` directly).
- Updated dependencies [d031275]
  - @neon/env@0.11.5

## 2.35.1

### Patch Changes

- a89d6ca: Pull a branch's object-storage vars without a `neon.ts`. `pullConfig` now mirrors the branch's buckets into the resolvable config, so `neon dev` / `neon env pull` inject the S3-compatible `AWS_*` credentials for a branch that has a bucket even when there is no local `neon.ts` policy — matching how Neon Auth / the Data API already resolve from live branch state. Functions and the AI Gateway remain excluded (neither has branch-level state that can be faithfully read back).
- Updated dependencies [a89d6ca]
  - @neon/config-runtime@0.9.6

## 2.35.0

### Minor Changes

- f62419c: Add project PostgreSQL-version selection, protected branch creation, and confirmed logical-replication enablement.

### Patch Changes

- c7c8156: Prevent the CLI from hanging while looking up `.neon` context files at Windows drive and UNC roots.

## 2.34.1

### Patch Changes

- Updated dependencies [a8e4937]
  - @neon/sdk@1.2.0
  - @neon/config@0.9.5
  - @neon/config-runtime@0.9.5
  - @neon/env@0.11.4

## 2.34.0

### Minor Changes

- 21db0be: Add a `snapshots` command group (alias `snapshot`) for managing Neon snapshots from the CLI: `list`, `get`, `create` (from a branch head, timestamp, or LSN, with optional expiration), `update` (rename / set / clear expiration), `delete`, `restore` (to a new branch or onto an existing branch, with optional immediate `--finalize`), `finalize` (commit a previewed restore), and `schedule get` / `schedule set` for a branch's automatic snapshot (backup) schedule.

### Patch Changes

- 2fa3793: Include the CLI version and CI context in error analytics events so failures can be investigated and prioritized accurately.

## 2.33.2

### Patch Changes

- 6b415c7: Fix AI Gateway "reduced model set" notices to consider only models with
  `enabled: true` from `/v1/models`. The gateway lists the full catalog but marks
  models the account cannot serve yet as `enabled: false`; previously the notice
  checked every listed id and could miss accounts on a trimmed catalog.

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
