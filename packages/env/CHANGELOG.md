# @neondatabase/env

## 1.1.2

### Patch Changes

- @neon/config@1.0.2

## 1.1.1

### Patch Changes

- @neon/config@1.0.1

## 1.1.0

### Minor Changes

- 0b37ad5: Opt-in OS keyring storage for a CLI profile via a `"keyring"` pointer in `profiles.json`. `neon profile create` no longer takes `--force`: creating an existing name replaces it and revokes the credential it held.

## 1.0.1

### Patch Changes

- 7bb17a9: Add exact environment-variable selection to `neon env pull`, and scope `fetchEnv({ keys })` work to the selected variables. Literal key lists autocomplete and narrow exactly, runtime-built lists return safely optional fields, and storage credential halves must be selected together. Pre-bound untyped key arrays that previously fell through to the full-env overload now fail type checking instead of promising unselected values.

## 1.0.0

### Major Changes

- 98c4aec: **Breaking (`@neon/env`): the `@neon/env/runtime` entry point is removed.** It held
  `fetchEnvReusingSecrets`, which reads an env source and can mint and revoke branch credentials.
  Its only consumers were Neon's own CLIs, and a library that revokes your credentials because you
  imported it is one you cannot safely embed — so it is now internal shared source rather than a
  published path. If you were importing it, use the `neon` CLI (`neon env pull`, `neon dev`), which does this for you. Rolling your own is possible but the hard part is not storing the secret — it is **verifying** it: a persisted secret is only reusable if it still names a live credential on that branch, unrevoked, unexpired, and carrying every scope the policy needs. A presence check cannot tell a real secret from a `.env.example` placeholder, which is the bug 0.12.0 shipped a fix for. `credentialScopesSatisfied` and `deriveCredentialScopes` from `@neon/config/v1`, plus `listCredentials` / `createCredential` / `revokeCredential` on a `NeonApi`, are the pieces.

  Everything else is unchanged: `fetchEnv`, `parseEnv`, `toEntries` and `NEON_ENV_VAR_KEYS` stay on
  `@neon/env` with the same signatures, and the `neon-env` binary is unaffected.

### Patch Changes

- Updated dependencies [35299c4]
  - @neon/config@1.0.0

## 0.15.0

### Minor Changes

- 6f8ba4d: `fetchEnvReusingSecrets` (`@neon/env/runtime`) takes a new `revokeSuperseded` option. It defaults to `true`, the existing behaviour. Pass `false` when the call resolves only part of what a branch has: object storage and the AI Gateway share one credential, so revoking the one your persisted secrets name can break a service the call is not rewriting. The credential it then leaves live is reported as `credential.superseded`, the counterpart to the existing `credential.revoked`.

## 0.14.1

### Patch Changes

- 4b9fd02: Emit `neon` instead of the removed `neonctl` binary name in help text, error hints, and `--agent` command templates, so suggested commands are runnable. When invoked via the `neonctl` compat package the commands still read `neonctl`.
- Updated dependencies [4b9fd02]
  - @neon/config@0.14.1

## 0.14.0

### Minor Changes

- aa31410: `neon profile create`, including API-key profiles, and an explicit `--profile` is no longer ignored

  Profiles could only hold an OAuth session, so the accounts that most need one — an agent, a
  shared machine, CI — could not use them. Worse, any API key voided the selection without saying
  so: `ensureAuth` returned as soon as `--api-key` or `NEON_API_KEY` was set, before the profile
  was resolved, so `neon --profile work …` ran as whoever the ambient key belonged to and reported
  nothing.

  ```bash
  neon profile create work                                 # sign in with the browser, like `neon auth`
  neon profile create work --api-key "$KEY"                # store a key you already have
  echo "$KEY" | neon profile create work --api-key -        # or pipe it, keeping it out of argv
  neon profile create ci --mint --org-id org-abc-123        # sign in once, keep only a minted org key
  neon profile create ci --mint --project-id proj-1         # or one scoped to a single project
  neon profile rotate-key ci                                # mint a replacement at the same scope
  neon --profile ci projects list                           # no browser, ever
  ```

  **A profile holds one kind of credential, never both.** `type` in the credentials file states
  which, and nothing is carried over when a profile is replaced. `profiles.json` is unchanged: a
  profile is still one name and one pointer, and `credentials` stays required because an entry
  without it makes 2.41 and 2.42 throw `ERR_INVALID_ARG_TYPE` from `resolveEntryPath`.

  `--mint` is the flow worth knowing: one browser sign-in, a key minted with that session, only the
  key stored, and the session signed back out — so afterwards nothing about the profile can open a
  browser. `--org-id` and `--project-id` narrow what it can reach, the same way they do on
  `neon api-keys create`, and the scope is recorded so `rotate-key` mints its replacement at the
  same one rather than quietly widening it. Every key is verified before being stored, and only a
  real API key is accepted; an OAuth access token would authenticate and then expire with nothing
  to refresh it.

  `profile list` gains `Auth` and `Scope` columns, and `SignedIn` becomes `File`, reporting `ok`,
  `invalid` or `missing`. A file existing never proved a credential valid, and for a key there is
  no session to be in — the column now names what was actually checked.

  **Precedence now follows one rule: an explicit flag beats an environment variable.** `--profile`
  wins over `NEON_API_KEY`, `--api-key` wins over `NEON_PROFILE`, passing both flags fails instead
  of picking a winner, and two ambient sources still resolve to the key — so a pipeline injecting
  `NEON_API_KEY` is unaffected — but the disregarded profile is named on stderr.

  This is a behaviour change: `neon --profile x` in an environment that exports `NEON_API_KEY` now
  resolves the profile, and fails with `Unknown profile "x"` when there is no such profile, where
  before the ambient key made it appear to work.

  Fixed alongside it, all in the same area:

  - A 401 no longer deletes the wrong account's credentials. The handler had only the config
    directory, so a rejected token on a `--profile`-selected account cleared whatever `DEFAULT`
    pointed at. It now acts on the exact file that failed, and only when the CLI created it — a
    profile may point at an adopted path that `profile remove` already refuses to delete. It never
    deletes an API key: there is nothing to refresh, so deleting it would destroy the only copy.
  - Analytics attributed every `--profile` command to the default account, because it read
    `DEFAULT`'s credentials regardless of what the invocation authenticated with.
  - `neon bootstrap` passed the resolved key to the `neon link` it re-executes, putting a secret in
    the child's process list — and `runCommand` prints the whole argument list when a command
    fails, so a failed link logged it too. It now forwards `--profile` and `--config-dir` (the
    latter having never been forwarded at all), and an explicit key travels in the environment.
  - `neon init` refuses profile selection instead of ignoring it, for `NEON_PROFILE` as well as
    `--profile`. It delegates auth to `neon-init`, which reads the default credentials directly, so
    honouring it is not possible yet — and running as the default account is worse than refusing
    when naming an account is the whole job of the thing being ignored.
  - `@neon/env` and `neon-init` read the stored credential's `type`, so a key-backed account is no
    longer reported as having no credentials at all.
  - `profile remove` revokes an API key it minted, and says the key is still live when it cannot.
    It confirms first, and refuses rather than prompting when stdin is not a terminal — guarded on
    CI alone, a piped stdin either waited for input that never arrived or exited **0** having
    removed nothing. Declining the prompt now exits non-zero, because nothing was removed.
  - `create --force` says what it is about to revoke. Replacing a profile has always retired the
    credential it held, so a key minted here stops working wherever else it was pasted; the message
    described a local replacement and left the irreversible half to be discovered.
  - `--api-key` is refused on `profile list`, `rotate-key` and `remove` instead of being accepted
    and ignored. It is a global option, so `.strict()` cannot see it, and `remove --api-key …`
    reported a revoke failure against a credential the user had not passed.
  - Credentials and `profiles.json` are written through a temporary file and a rename.
    `writeFileSync`'s `mode` applies only when it creates a file, so an existing credentials file
    kept whatever permissions it already had — one created `0700` by a release before `0600` became
    the default stayed `0700` indefinitely. Every write now lands owner-only on a fresh inode.
  - `readCredentials` treats only a missing file as "no credentials". A permission or I/O error used
    to look identical to absence, so it would start a browser login that overwrote a credential the
    CLI simply could not read. `@neon/env` and `neon-init` now agree: a damaged credentials file is
    an error naming the file and the repair, where they previously reported "not signed in" and, in
    `neon-init`'s case, offered a browser sign-in that would overwrite it. `neon-init` also reports
    a failure in the shape the caller asked for: under `--json` an error is now a JSON object with
    a non-zero exit, where anything thrown used to print the help screen and a stack trace.
  - **A malformed credentials file no longer echoes its own contents.** `JSON.parse` quotes a window
    of the input around a syntax error, so a truncated credentials file produced
    `Unexpected token 'a', ..."api_key":napi_SUPERS"... is not valid JSON` — printed by
    `profile list` and by every failed authentication. Diagnostics now name the file and nothing
    from inside it.
  - A file declaring `"type": "api_key"` without a key is reported as invalid rather than as a
    working key profile, and no revocation is attempted for it. `list` showed it as usable, and
    `remove` sent an empty credential to the revoke endpoint and reported the failure as if the key
    might still be live.
  - A malformed `profiles.json` is never rewritten, and nothing that acts on a named profile runs
    before it is checked. It was treated as absent, so `profile create` rebuilt it from a single
    `DEFAULT` entry and discarded every named profile in it, and — because
    `credentials.<name>.json` is only a convention, with the entry that confirms whose file it is
    being the unreadable part — `create` could overwrite that file and revoke the key it held, and
    `neon auth --profile` could sign in over it, before refusing. `DEFAULT` is unaffected, so the
    ordinary sign-in that repairs the situation still works, and entry names and paths are
    validated as they are read.

  **All three CLIs read credentials the same way now.** The credential, profile and config-path
  code moved to `shared/cli-core`, which `neon`, `@neon/env` and `neon-init` each compile into
  their own build — it is copied into `src/_shared` before they compile, so the code ships inside
  every `dist` and nothing new appears on the registry. **`@neon/config/paths` is removed.** It only ever
  existed because implementor-only code had nowhere else to live: it was never documented in the
  package's README, and nothing outside this repo imported it. The resolution it exposed now
  reaches each CLI by being compiled into it, so a policy-facing package no longer carries
  filesystem and environment reads. `@neon/config` and `@neon/config/v1` are unchanged.

  The point of it is that the three stop disagreeing. `neon-env` gains `--profile` and honours
  `NEON_PROFILE`, so `neon --profile dbx env` and `neon-env` can no longer resolve different
  accounts; and `neon-init` reads the stored credential through the same reader, so an account
  signed in with an API key is no longer treated as not signed in and sent to a browser.

### Patch Changes

- Updated dependencies [aa31410]
  - @neon/config@0.14.0

## 0.13.3

### Patch Changes

- @neon/config@0.13.2

## 0.13.2

### Patch Changes

- @neon/config@0.13.1

## 0.13.1

### Patch Changes

- 4b37fc8: Add `neon profile`, and move the config directory to `~/.config/neon`

  **Profiles.** The CLI could only hold one Neon account, so anyone with two built their own
  workaround out of `--config-dir` and shell aliases. A profile is now just a pointer to a
  credentials file:

  ```bash
  neon auth --profile work     # create or re-authenticate
  neon profile list            # names, accounts, and where each one's credentials live
  neon profile remove work     # revoke the token, delete the file, drop the entry
  neon deploy --profile work   # or NEON_PROFILE=work
  ```

  Selection is per invocation — `--profile`, else `NEON_PROFILE`, else `DEFAULT` — so there is
  no stored "active profile" to disagree with what you typed.

  `DEFAULT` **is** `credentials.json`, not a copy of it, and `profiles.json` is only created
  once a second profile exists. An install with one account is unchanged, on disk and in
  behaviour, and there is no migration step.

  `neon profile remove` revokes the refresh token at the authorization server rather than only
  deleting the file, and it deletes a credentials file only if the CLI created it — a profile
  pointing at a directory you already had is unlinked and left alone, and says so.

  **Config directory.** New installs use `$XDG_CONFIG_HOME/neon`, else `~/.config/neon`. An
  existing `neonctl` directory is still read, **in place** — nothing is moved, copied, or
  deleted, so no second copy of a credential can go stale behind you. An explicitly chosen
  directory (`--config-dir`, `NEON_CONFIG_DIR`, `NEONCTL_CONFIG_DIR`) is exact and never falls
  back.

  This also fixes three readers that disagreed about where the directory was: `neon` honoured
  `XDG_CONFIG_HOME` but not `NEONCTL_CONFIG_DIR`, `neon-env` honoured the env var but not XDG,
  and `neon-init` hardcoded `~/.config/neonctl`. With `XDG_CONFIG_HOME` set, the CLI wrote
  credentials somewhere the other two never looked. `@neon/config/paths` is now the single
  implementation; `neon-init` matches it inline rather than taking on the dependency.

  Credentials files are now written `0600` instead of `0700` — a credential needs read and
  write, never execute.

- Updated dependencies [4b37fc8]
  - @neon/config@0.13.0

## 0.13.0

### Minor Changes

- 3ade88e: Require an explicit `apiKey` — these packages no longer read `NEON_API_KEY` or `~/.config/neonctl/credentials.json`

  `@neon/config` is documented as the pure half of the config toolchain, and `@neon/env`'s root
  export as "never reads `process.env` or a file", but `createNeonApiFromOptions` reached for an
  ambient credential when none was passed. That made `inspect`, `plan`, `apply`, `pushConfig`,
  `pullConfig` and `fetchEnv` authenticate as whoever last ran `neon auth`, with no way for an
  embedder to opt out.

  `createNeonApiFromOptions(operation, { apiKey, apiHost })` now requires `apiKey` and throws
  `PLATFORM_MISSING_API_KEY` without one. It reads no environment variables and no files.
  `resolveApiKey` is removed from `@neon/config/v1`.

  `apiHost` is unchanged in spirit: still optional, still defaulting to production
  (`https://console.neon.tech/api/v2`). Only the ambient `NEON_API_HOST` lookup is gone — pass
  `apiHost` explicitly to target a non-production API.

  **If you were relying on the fallback**, resolve the key where you already know your users'
  conventions and pass it in:

  ```ts
  import { apply } from "@neon/config-runtime/v1";

  await apply(config, {
    projectId,
    branchId,
    apiKey: process.env.NEON_API_KEY, // your call, not the library's
  });
  ```

  The `neon` and `neon-env` CLIs are unaffected — both resolve the key themselves and always
  passed it explicitly. `neon-env`'s `--api-key` still defaults to `NEON_API_KEY` and then the
  Neon CLI's stored credentials, now via its own `resolveApiKey`.

### Patch Changes

- Updated dependencies [3ade88e]
  - @neon/config@0.12.0

## 0.12.2

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

## 0.12.1

### Patch Changes

- @neon/config@0.10.1

## 0.12.0

### Minor Changes

- 4ae4e1a: `neon env pull` now verifies branch credential secrets instead of trusting whatever is on disk, and `fetchEnv` becomes a pure fetch.

  Object storage and AI Gateway secrets are returned once at mint time, so resolving a branch's env reused the persisted copy rather than minting a credential per call. That reuse was presence-based, so a `.env.example` placeholder counted as a real secret: copying one and running `neonctl env pull` left the placeholders in place, reported as pulled, and produced a `.env` that did not work.

  **`fetchEnv` no longer reads any env source.** The `env` option is gone; it returns exactly what the Neon API reports, and mints a credential only when a credential-backed var is requested. It gains a `keys` filter — the same typesafe, autocompleting selection `parseEnv` accepts — and the filter skips work, not just result fields: leave out `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `NEON_AI_GATEWAY_TOKEN` and no credential is minted at all. `NEON_BRANCH` is now a selectable key. `toEntries` accepts a filtered result.

  **New `@neon/env/runtime` entry point**, holding `fetchEnvReusingSecrets(config, { projectId, branch, env })`. It owns everything stateful, outside `fetchEnv`: it verifies the persisted secrets against the branch's live credentials, keeps them only when they name one that still exists, is not revoked or expired, and carries every needed scope, and otherwise mints a replacement and revokes what it superseded. Returns `{ vars, credential }` — no callback. This needs no local bookkeeping, because `AWS_ACCESS_KEY_ID` is the credential's token id and the AI Gateway token embeds its short id, so the persisted secrets already name the credential that issued them.

  The subpath keeps the root export pure: an app or build script importing `@neon/env` is offered `fetchEnv` / `parseEnv` / `toEntries` and nothing that reads an env source or mutates credentials. Same split as `@neon/config` vs `@neon/config-runtime`.

  `neon env pull`, `neon dev`, and `neon-env run` / `export` all go through the wrapper, so all three now verify rather than trust. `env pull` reports re-issued credentials by name so you know which values changed. Also: `fetchEnv` reads a branch's storage settings before minting, so a policy declaring buckets on a branch without storage fails without having spent a credential.

## 0.11.8

### Patch Changes

- Updated dependencies [57461c9]
  - @neon/config@0.10.0

## 0.11.7

### Patch Changes

- 44a95e8: Restore editor autocomplete for `parseEnv`'s function-slug scope. Typing
  `parseEnv(config, "…")` offered no completions, so the declared slugs of
  `preview.functions` had to be recalled by hand (the slugs were already
  type-checked — an undeclared one was always a type error — only the suggestions
  were missing). The cause was overload order: an editor takes string-literal
  completions from the first candidate overload, and the key-array overload was
  declared first, so the expected type of the argument was read as an array, which
  has no literal completions. The slug overload now comes first and the slugs
  autocomplete. A policy that declares no functions at all also reports a readable
  hint instead of the opaque `Type '"x"' is not assignable to type 'never'`.

## 0.11.6

### Patch Changes

- @neon/config@0.9.6

## 0.11.5

### Patch Changes

- d031275: Auto-pick Neon's default `neondb` database when a branch has more than one. Previously `fetchEnv` threw as soon as a branch had multiple databases, so `neonctl link` / `neonctl env pull` failed on a branch that had `neondb` alongside another database. It now uses `neondb` when present (or the sole database otherwise); a branch with several databases and no `neondb` still throws so the choice is never made randomly — rename one to `neondb` or keep a single database (or pass `databaseName` when calling `fetchEnv` directly).

## 0.11.4

### Patch Changes

- @neon/config@0.9.5

## 0.11.3

### Patch Changes

- Updated dependencies [3abe4f7]
  - @neon/config@0.9.4

## 0.11.2

### Patch Changes

- 22d5cdd: Reference the `neon` CLI over `neonctl` in user-facing output and docs. The CLI
  ships both the `neon` and `neonctl` binaries; `neonctl` keeps working as an
  alias, but `neon init` now emits `neon …` commands, status messages, and
  agent-facing prompts using the cleaner `neon` name, and the package READMEs
  document `neon`. Internal package install/version checks and the
  `~/.config/neonctl/` config path are unchanged.
- Updated dependencies [22d5cdd]
  - @neon/config@0.9.3

## 0.11.1

### Patch Changes

- @neon/config@0.9.2

## 0.11.0

### Minor Changes

- 3ad35b3: AI Gateway env is now exposed only under its Neon-branded vars. `preview.aiGateway` no longer emits the OpenAI SDK aliases `OPENAI_API_KEY` / `OPENAI_BASE_URL` — matching the deployed Functions runtime, which only injects `NEON_AI_GATEWAY_TOKEN` / `NEON_AI_GATEWAY_BASE_URL`.

  - `fetchEnv` / `parseEnv` / `toEntries` now read and write `NEON_AI_GATEWAY_TOKEN` and `NEON_AI_GATEWAY_BASE_URL`. `env.aiGateway.apiKey` maps to the token and `env.aiGateway.baseUrl` is now the **bare** gateway host (`https://<branch>-api.ai.<region>.…`, no `/ai-gateway/openai/v1` path) — clients like `@neon/ai-sdk-provider` append the dialect routes themselves.
  - `neonctl env pull` no longer writes `OPENAI_*`, and now owns/prunes the `NEON_AI_GATEWAY_*` vars.

  Migration: if you relied on the injected `OPENAI_API_KEY` / `OPENAI_BASE_URL`, read `NEON_AI_GATEWAY_TOKEN` / `NEON_AI_GATEWAY_BASE_URL` instead (or set your own `OPENAI_*` by hand — `env pull` leaves user-set vars untouched).

## 0.10.1

### Patch Changes

- @neon/config@0.9.1

## 0.10.0

### Minor Changes

- Support Node.js >= 20.19 at runtime. Every published package now declares
  `engines.node: ">=20.19.0"` — the real floor of its dependency tree — instead of `>=22`, so the
  packages install and run cleanly on Node 20 without any dependency downgrades (`neonctl` moves
  from `>=20.18.1` to `>=20.19.0` to match `chokidar@5`). Contributing to the repo still requires
  Node 22 (pnpm + SDK codegen); see `CONTRIBUTING.md`.

### Patch Changes

- Updated dependencies
  - @neon/config@0.9.0

## 0.9.0

### Minor Changes

- b78ced2: Resolve branches by name or id, not id only. `fetchEnv` now accepts a `branch` option holding either a branch name (e.g. `main`) or an id (`br-…`); the legacy id-only `branchId` option still works. The `neon-env` CLI reads the `branch` field from the flat `.neon` file written by `neonctl link` (falling back to legacy `branchId`), and honors `NEON_BRANCH` in addition to `NEON_BRANCH_ID`. This fixes `neon-env run`/`export` failing to resolve a branch pinned by name.

## 0.8.1

### Patch Changes

- Updated dependencies [1f77d97]
  - @neondatabase/config@0.8.1

## 0.8.0

### Minor Changes

- Drop the `/v1` subpath export — import everything from the package root instead.

  `@neondatabase/env/v1`, `@neondatabase/functions/v1`, and `@neondatabase/ai-sdk-provider/v1` are no longer published. Use the package root (`@neondatabase/env`, `@neondatabase/functions`, `@neondatabase/ai-sdk-provider`), which already exposed the full surface. Versioned subpath exports remain only on `@neondatabase/config` and `@neondatabase/config-runtime`, where pinning a policy-schema major is meaningful.

## 0.7.0

### Minor Changes

- fe5d092: Remove the `NEON_STORAGE_FORCE_PATH_STYLE` env var and the `storage.forcePathStyle` field from `NeonStorageEnv`.

  It was always `true` and has no AWS-standard env name, so the S3 SDKs never read it automatically — you already had to wire `forcePathStyle` into your `S3Client` by hand. Neon's storage gateway always requires path-style addressing, so set `forcePathStyle: true` directly on your client. `env pull` no longer writes the variable, and `parseEnv` / `toEntries` no longer read or emit it. The raw `NeonBranchStorageSnapshot.forcePathStyle` from `@neondatabase/config` (the `GET .../storage` response) is unchanged.

- 75abe16: Remove the `NEON_STORAGE_REGION` env var (the Neon-branded alias of `AWS_REGION`).

  The region is already injected under the SDK-standard `AWS_REGION`, which the AWS S3 SDKs read automatically — the duplicate `NEON_STORAGE_REGION` alias was never read back by `parseEnv` and bought nothing. `env pull` no longer writes it and `toEntries` no longer emits it. `NeonStorageEnv.region` (mapped to `AWS_REGION`) is unchanged.

## 0.6.0

### Minor Changes

- 0cabe8e: Add branch-scoped service credentials + object-storage / AI Gateway env (Preview).

  - `@neondatabase/config`: the `NeonApi` adapter gains `createCredential` / `listCredentials` / `revokeCredential` (the beta `…/credentials` endpoints) and `getProjectBranchStorage` (the beta `…/storage` endpoint → `s3_endpoint` / `region` / `force_path_style`), plus the `CredentialScope` / `CredentialPrincipalType` types, the `NeonCredentialSecret` / `NeonCredentialMeta` / `CreateCredentialInput` / `NeonBranchStorageSnapshot` shapes, and pure `deriveCredentialScopes` / `credentialScopesSatisfied` helpers.
  - `@neondatabase/env`: `fetchEnv` / `parseEnv` expose two new namespaces, mapped onto the **SDK-standard** env names so the AWS and OpenAI SDKs work from env alone:
    - `env.storage` (when `preview.buckets`) → `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION` (and `NEON_STORAGE_REGION`), `NEON_STORAGE_FORCE_PATH_STYLE`.
    - `env.aiGateway` (when `preview.aiGateway`) → `OPENAI_API_KEY`, `OPENAI_BASE_URL` (the branch gateway host + `/ai-gateway/openai/v1`).
    - The access keys come from a minted branch credential; the S3 endpoint/region/path-style come from `getProjectBranchStorage`. `functions:invoke` rides along on the credential's scopes when functions are also declared, but functions never mint a credential on their own. `fetchEnv` reuses the secrets already present in its env source (round-tripping the one-time `api_token` / `s3_secret_access_key`) and only re-mints when a needed secret is missing. Policies without `preview.buckets` / `preview.aiGateway` never touch the credentials/storage endpoints, so the Postgres / Auth / Data API path is unchanged.
  - `@neondatabase/config-runtime`: `pullConfig` / `inspect` report secret-free issued-credential metadata under `preview.credentials` (degrading to none when the endpoint is unavailable).

- 71adaba: Inject `NEON_BRANCH` (the branch name) alongside the other Neon env vars.

  The Neon Functions runtime injects `NEON_BRANCH` into every branch (including the default)
  by default, so `fetchEnv` now surfaces the branch on a new optional `branch` namespace and
  `toEntries` emits `NEON_BRANCH`. That means `neon dev` / `neon-env run` / `neon env pull`
  write `NEON_BRANCH` into local dev too, mirroring the deployed runtime. `parseEnv` reads it
  back when present (optional — a missing `NEON_BRANCH` is not an error, so existing
  deployments and platform integrations keep working). The value is the branch **name** for now.

- c6a00b7: Add an optional key filter to `parseEnv` for requiring + returning only a subset of env vars.

  `parseEnv(config, keys)` now accepts an array of OS-level env-var keys (e.g.
  `["DATABASE_URL", "NEON_AUTH_BASE_URL"]`) as an alternative to the function-slug scope. In
  this mode only the selected vars are enforced and returned, projected into a **narrowed**
  `NeonEnv` shape — so a Next.js app that reads `DATABASE_URL` but not `DATABASE_URL_UNPOOLED`
  no longer throws over vars it never uses. The keys are typesafe against the policy
  (`SelectableEnvKey<Config>`): selecting a var from a namespace the policy doesn't enable is a
  compile error, and the result type drops both unselected namespaces and unselected properties
  within a kept namespace.

- 3fbf556: Remove the function `memoryMib` setting entirely.

  **Breaking.** Function memory is no longer user-configurable from `neon.ts` or the deploy
  API surface — it is fixed by the platform policy.

  - `@neondatabase/config`: drop `FunctionMemoryMib`, remove `memoryMib` from `FunctionTuning`,
    `ResolvedFunctionConfig`, and `DeployFunctionInput`. The real NeonApi adapter no longer
    sends a `memory_mib` form field.
  - `@neondatabase/config-runtime`: stop threading `memoryMib` through plan/apply steps.
  - A `neon.ts` that sets `branch.preview.functions[slug].memoryMib` is now a type error and
    is rejected by the schema.

- 0d4c973: Reshape `defineConfig` into a static existential set + a tuning-only `branch` closure.

  **Breaking.** `defineConfig` now takes an **object**, not a function:

  ```ts
  export default defineConfig({
    auth: true,
    dataApi: false,
    preview: {
      aiGateway: false,
      functions: {
        hello: {
          name: "Hello",
          source: "./functions/hello.ts",
          dev: { port: 8787 },
        },
      },
      buckets: { uploads: { access: "public_read" } },
    },
    branch: (branch) => ({
      protected: branch.name === "main",
      preview: { functions: { hello: { memoryMib: 1024 } } },
    }),
  });
  ```

  - GA service toggles (`auth`, `dataApi`) and the beta `preview` block (`aiGateway`,
    `functions`, `buckets`) are **static and top-level**, so the secret set is known at the
    type level. `functions`/`buckets` are **records keyed by slug/name** (regex-enforced,
    dup-free).
  - The `branch` closure is **tuning-only** (`parent`/`ttl`/`protected`/`postgres` + per-function
    `memoryMib`/`runtime`), and is type-constrained to only reference declared function slugs.
    It cannot add or remove services or functions.
  - `resolveConfig` still returns the same `ResolvedBranchConfig`, so `diff`/`plan`/`apply`
    are unchanged at runtime. `pullConfig` now returns the new `Config` shape.
  - `@neondatabase/env`: `NeonEnv<C>` is derived directly from the static toggles, so it is
    exact. `parseEnv` drops the `branchName` argument and takes an optional **scope** — omit
    for external env, or pass a function slug to also get a typed `function` namespace of that
    function's declared env keys.

### Patch Changes

- b6efa3a: Fix the AI Gateway env URL and add `NEON_AI_GATEWAY_*` vars.

  `fetchEnv` / `env pull` built `OPENAI_BASE_URL` from the **control-plane API origin** (`<NEON_API_HOST>/ai-gateway/openai/v1`), which doesn't serve the gateway (returns 403/CSRF from the console). The AI Gateway is a **branch-scoped host** (`<branchId>-api.ai.<region>.…`).

  - `OPENAI_BASE_URL` is now derived from the branch's Postgres connection host (`<branchId>-api.ai.[c-N.]<region>.<cloud>.neon.<tld>/ai-gateway/openai/v1`), keeping any infra cell prefix.
  - `env pull` additionally emits the Neon-branded aliases alongside the OpenAI ones:
    - `NEON_AI_GATEWAY_TOKEN` — the credential bearer (same value as `OPENAI_API_KEY`).
    - `NEON_AI_GATEWAY_BASE_URL` — the bare branch gateway host (`scheme://host`, no path), as consumed by the `@ai-sdk/neon` provider, which appends the `/ai-gateway/<dialect>/…` routes itself (https://github.com/vercel/ai/pull/15997).

- Preserve the infra cell prefix (`c-N.`) when deriving the AI Gateway host.

  `fetchEnv` / `env pull` build the branch gateway host (`OPENAI_BASE_URL` and the bare-host alias `NEON_AI_GATEWAY_BASE_URL`) from the branch's Postgres connection host. It dropped the `c-N.` cell segment, producing `https://<branch-id>-api.ai.<region>.<cloud>.neon.<tld>`. The gateway is cell-routed, so the correct host keeps the cell — matching the Console value:

  ```
  # before (wrong host — missing cell)
  NEON_AI_GATEWAY_BASE_URL=https://br-…-api.ai.us-east-2.aws.neon.tech

  # after (matches Console)
  NEON_AI_GATEWAY_BASE_URL=https://br-…-api.ai.c-3.us-east-2.aws.neon.tech
  ```

  The host suffix is now taken verbatim after the endpoint label, keeping any `c-N.` prefix intact.

- 1fc049d: Surface the Neon Auth JWKS URL as `NEON_AUTH_JWKS_URL`.

  When a branch policy enables `auth`, `fetchEnv` / `parseEnv` / `toEntries` now expose
  `env.auth.jwksUrl` (`NEON_AUTH_JWKS_URL`) alongside the existing `env.auth.baseUrl`, so
  apps and agents get the JWKS endpoint needed to verify Neon Auth tokens — not just the base
  URL. `fetchEnv` reads it from the live integration's `jwks_url`; `parseEnv` reads and
  validates it from `process.env`.

- 11c14e6: Default `fetchEnv` to the `neondb_owner` role when a branch has several roles.

  Enabling Neon Auth / the Data API provisions the PostgREST roles
  (`authenticator`, `anonymous`, `authenticated`) alongside the project owner, so `env pull`
  saw multiple roles and refused to auto-pick the connection role. `fetchEnv` now defaults to
  Neon's owner role (`neondb_owner`) — or, for projects created with a custom owner name, the
  single role left after dropping those managed Auth/Data API roles — and only asks for an
  explicit `roleName` when more than one app role genuinely remains.

- c57536b: Honor `NEON_API_HOST` / the new `apiHost` option when building the default Neon API client. `createNeonApiFromOptions` now resolves the host (explicit `apiHost` option → `NEON_API_HOST` env → production default), and `pullConfig`, `pushConfig`, `inspect`/`plan`/`apply`, and `fetchEnv` accept and forward an optional `apiHost`.
- ae9a478: Fix object-storage credentials: map `AWS_ACCESS_KEY_ID` to the credential's full token id.

  `fetchEnv` / `parseEnv` previously injected the credential's short token id (`token_id_short`, e.g. `805e248a8e54`) as `AWS_ACCESS_KEY_ID`. The storage gateway only accepts the full token id (`token_id`, e.g. `nak_live_805e248a8e54…`), so every S3 request failed with `InvalidAccessKeyId`. `env.storage.accessKeyId` (and `AWS_ACCESS_KEY_ID`) now carries the full token id, making the standard object-storage path usable.

- Updated dependencies [101c4cb]
- Updated dependencies [0cabe8e]
- Updated dependencies [b6efa3a]
- Updated dependencies [9170128]
- Updated dependencies [4702726]
- Updated dependencies [11c14e6]
- Updated dependencies [b6efa3a]
- Updated dependencies [c57536b]
- Updated dependencies [5c7c006]
- Updated dependencies [101c4cb]
- Updated dependencies [b6efa3a]
- Updated dependencies [3fbf556]
- Updated dependencies [0d4c973]
  - @neondatabase/config@0.8.0

## 0.1.2

### Patch Changes

- Updated dependencies
  - @neondatabase/config@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [ff7103b]
  - @neondatabase/config@0.2.0

## 0.1.0

### Minor Changes

- 81cfe0a: Initial release of the Config-as-Code packages for the Neon Platform.

  **`@neondatabase/config`** — the authoring surface you import from `neon.ts`. Define your Neon project, branches, TTLs, compute settings, and Preview features in a single typed policy. Intentionally free of heavy/native dependencies so importing it stays cheap and bundler-safe.

  - `defineConfig(input)` — strict, zod-backed config validation that aggregates every issue into a single error.
  - `diffConfig(...)` — the pure diff engine (desired policy vs. live state → plan steps).
  - `createRealNeonApi` + the `NeonApi` interface, the config loader, and a fully typed, actionable error surface (every error carries a stable `code` and structured `details`).
  - A `preview` block for upcoming Neon Platform features (all backed by `x-stability-level: beta` endpoints):
    - **`preview.functions`** — deploy worker/Vercel-style handlers (`export default { fetch }` or `export async function handler(req)`) from a `source` file path. Supports per-function `env` (validated as defined strings), `runtime` (`nodejs24`), and `memoryMib`, with sane defaults.
    - **`preview.buckets`** — branchable object-storage buckets, each `{ name, access?: "private" | "public_read" }` (defaults to `private`).
    - **`preview.aiGateway`** — an `{ enabled }` toggle, mirroring the `auth` / `dataApi` semantics.

  ```ts
  import { defineConfig } from "@neondatabase/config/v1";

  export default defineConfig((branch) => ({
    preview: {
      functions: [
        {
          name: "Hello World",
          slug: "hello-world",
          source: "./functions/hello-world.ts",
          env: { RESEND_API_KEY: process.env.RESEND_API_KEY },
        },
      ],
      buckets: [{ name: "uploads", access: "public_read" }],
      aiGateway: { enabled: true },
    },
  }));
  ```

  **`@neondatabase/config-runtime`** — the imperative runtime. Reads a branch's live state, diffs a policy against it, applies changes, and bundles + deploys Neon Functions. Function bundling pulls in `esbuild`, so this is the package CLIs and CI import — keeping `esbuild` out of the dependency tree of anyone who only imports `defineConfig` from `neon.ts`.

  - `inspect` / `plan` / `apply` (Terraform-style), plus the lower-level `pushConfig` / `pullConfig` engine.
  - Preview features are applied **additively** (buckets and functions are created and the AI Gateway is enabled; nothing is auto-deleted), and `inspect` / `pullConfig` reports a branch's live Preview state.
  - `buildFunctionBundle` — bundles a function's `source` with esbuild and zips it for deploy.

  **`@neondatabase/env`** — resolves and injects Neon connection strings for the branch selected by your `neon.ts` policy.

  - `fetchEnv` / `parseEnv` — return a fixed, statically-typed, namespaced env shape (e.g. `env.postgres.databaseUrl`).
  - A single `neon-env run -- <cmd>` CLI to run any command with the resolved Neon connection strings injected into its environment.

### Patch Changes

- Updated dependencies [81cfe0a]
  - @neondatabase/config@0.1.0
