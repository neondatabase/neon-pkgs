# neon

## 4.5.0

### Minor Changes

- 512baf3: Add `neon claim` and its `claimable` alias for creating, using, claiming, listing, and deleting temporary Claimable Neon projects without an account. `status`, `accept`, and `delete` take an optional project id from `claim list`. `list` prints `state` from the assertion clock and the project expiry, and `delete` drops a local record after the identity assertion expires. `create` prints CLI service names and `project_expires_at`.

  Recognize Claimable Neon capability errors in Config-as-Code so unavailable pre-claim services keep their actionable claim guidance instead of being reported as API-key failures.

### Patch Changes

- Updated dependencies [512baf3]
  - @neon/config@1.0.3
  - @neon/config-runtime@1.0.3

## 4.4.0

### Minor Changes

- bdb0db6: Add `neon plugins` to install the Neon agent plugin into coding agents. A TTY asks agents, then confirms. `-y` installs into detected agents at project scope. `--agent` names specific agents. `--global` is user scope.

### Patch Changes

- Attribute CLI telemetry to Claude Code and Codex command trees.

## 4.3.1

### Patch Changes

- 894b427: `neon mcp` mints a project-scoped API key when `--project-id` is set or a linked project is pinned, instead of an account-wide key.

## 4.3.0

### Minor Changes

- eb52252: Add `neon skills` to install Neon agent skills into coding agents. A TTY asks agents and skills, then confirms. `-y` installs the default skills into detected agents in this directory. `--skill` names specific skills. `--global` is user-level. `neon skills update` refreshes installed skills.

## 4.2.1

### Patch Changes

- 9c5ecf5: List commands print every populated column at full width on one line per row. A narrow terminal wraps the line instead of dropping or truncating columns. `neon branches list` and `neon snapshots list` show Expires At before Created At, including on get and create. `neon projects list --recoverable-only` shows Recoverable Until before Deleted At.

## 4.2.0

### Minor Changes

- 55f4bf2: Add `neon mcp` to install the Neon MCP server into coding agents. A TTY asks config location (global default), agents, API key vs OAuth, then confirms. Linked project-folder installs also ask whether to pin tools to that project. `-y` is global, detected agents, minted write API key. `--project` is config location only. `--read-only`, `--project-id` and `--category` set MCP URL query params. The minted key is always account-wide.

## 4.1.0

### Minor Changes

- 6ff43d7: Add `neon inspect db stalled-queries`, a read-only snapshot of active queries running longer than 30 seconds. Table output shows duration, wait event, blocking pids, role, query group, and query. `--output json` includes the full row.

## 4.0.0

### Major Changes

- d606a2e: `neon neon-auth config email-provider test` now sends through the custom SMTP provider saved on the branch. Only `--recipient-email` is accepted; `--host`, `--port`, `--username`, `--password`, `--sender-email`, and `--sender-name` are rejected. Save the provider first with `neon neon-auth config email-provider update --type standard`.

## 3.6.1

### Patch Changes

- Updated dependencies [93b93dc]
  - @neon/sdk@2.2.0
  - @neon/config@1.0.2
  - @neon/config-runtime@1.0.2

## 3.6.0

### Minor Changes

- 23740cd: `neon` list and get commands no longer draw box-drawing tables. Default output is space-padded columns that drop and truncate to the terminal width, or stacked `Label  value` lines for a single object. `--output json` and `--output yaml` keep the same fields; `neon profile list` reports OAuth scope as `account` in every format.
- e78f193: `neon init` honors `--profile` and `NEON_PROFILE`. `npx neon` subprocesses and agent-emitted commands include `--profile <name>` when a profile was named, and `--config-dir` when you passed it.

## 3.5.1

### Patch Changes

- Updated dependencies [5c57d00]
  - @neon/sdk@2.1.0
  - @neon/config@1.0.1
  - @neon/config-runtime@1.0.1

## 3.5.0

### Minor Changes

- 745c267: `neon init` installs the Neon MCP server through add-mcp's library and offers every agent add-mcp supports. Skills still use a fixed map from those agent ids; agents with no skills CLI id are skipped instead of falling back to Cursor.

## 3.4.0

### Minor Changes

- 5abe208: `neon inspect db` without `--database-name` now runs each database-scoped check against every database the API lists for the branch and adds a `database` column, including on a branch that has only one database. That column is new on the default invocation. Compute-wide checks still run once and keep their previous columns. Pass `--database-name` to keep the previous columns on a database-scoped check. `locks` and `long-running-queries` also report only the database you name with the flag; they previously listed sessions from every database, and `locks` printed an empty or wrong relation name for those foreign rows.

## 3.3.0

### Minor Changes

- 0b37ad5: Opt-in OS keyring storage for a CLI profile via a `"keyring"` pointer in `profiles.json`. `neon profile create` no longer takes `--force`: creating an existing name replaces it and revokes the credential it held.

## 3.2.2

### Patch Changes

- e8715cd: `neon init --agent` labels the CLI install step `neon`, and the README says init installs `neon` globally. `npm i -g neon` only puts `neon` on PATH.

## 3.2.1

### Patch Changes

- ad7cf9a: `neon init` now detects and installs the `neon` CLI instead of the retired `neonctl` alias. Version probing checks `neon` first (falling back to `neonctl` so an existing global install still counts as installed), the update check reads `npm view neon`, and auth/context lookups shell out to `neon`.

## 3.2.0

### Minor Changes

- 998728b: Add `neon open` to open the project linked in `.neon` in the Neon Console.

## 3.1.1

### Patch Changes

- 7bb17a9: Add exact environment-variable selection to `neon env pull`, and scope `fetchEnv({ keys })` work to the selected variables. Literal key lists autocomplete and narrow exactly, runtime-built lists return safely optional fields, and storage credential halves must be selected together. Pre-bound untyped key arrays that previously fell through to the full-env overload now fail type checking instead of promising unselected values.

## 3.1.0

### Minor Changes

- 5305087: Add `neon logs query`, `neon logs fields` and `neon logs field-values <field>` for reading the logs a branch's functions, object storage and Postgres computes emit. Requires Neon Platform Beta, and is currently available only for projects in `aws-us-east-2`.

### Patch Changes

- 9f51632: Install and tool commands now use your project's package manager everywhere, not just in `neon config init`

  `neon bootstrap` and the `neon init` getting-started and migration steps told agents to run `npm install`, `npm install @neondatabase/serverless`, and `npm install -D prisma` regardless of the project's lockfile — which fails outright in a pnpm project, where npm's resolver chokes on the symlinked `node_modules`. They now emit the command for the manager the project actually uses (`pnpm add -D prisma`, `bun add -D drizzle-kit`, and so on).

  The tools those steps then run follow the project too: `pnpm exec drizzle-kit migrate` and `bun run prisma generate` rather than `npx`. These are local-only forms, so a step that runs before its dependencies are installed now fails instead of silently downloading an unpinned copy of the tool.

  The global `neonctl` and `skills` installs follow the package manager that invoked the CLI instead of always using npm, and report clearly when the machine has no way to install a CLI globally.

## 3.0.0

### Major Changes

- 3cb16e1: Stage the real files of a function's `externalPackages` into the deployed archive, so a
  package backed by a native binary works on Functions instead of failing at invoke. Each
  declared package is installed for the runtime target (linux-arm64, glibc) into a throwaway
  directory, traced for the files it actually reaches, and copied under `node_modules/` with
  its directory layout preserved. The user's own `node_modules` is never read for those files
  or modified.

  An entry with `includeFiles: false` is externalized and nothing is staged for it, which is
  the pre-existing behaviour. A function whose entries all opt out — or which declares none —
  produces a byte-identical archive to before.

  Deploys and `neon dev` now report a package that was bundled in, carries native code, and
  was never declared. The report is advisory and never fails a deploy: the evidence shows the
  package contains compiled code, not that this function reaches it, and a package with a
  working JavaScript fallback looks identical.

  Fixes version pinning for packages whose `exports` map does not list `./package.json`.
  `sharp` is one, so the version the user had installed was never read and the registry's
  latest was staged instead. Versions are now read from the package directory rather than
  through the resolver, and a package whose version still cannot be determined is reported
  instead of being staged silently.

- 98c4aec: Deep imports under `neon/dist/_shared/` no longer resolve. That directory holds source compiled in
  from the repo's shared trees — credential reading, and the branch-credential mint/revoke logic —
  which the `./dist/*` wildcard made importable by accident. `neon/dist/_shared/credentials.js` was
  reachable before this change. Everything else under `neon/dist/` is unaffected, and none of it was
  ever a supported surface: the CLI's entry points are the `neon` binary, `neon` and `neon/cli`.

### Patch Changes

- 98c4aec: **Breaking (`@neon/env`): the `@neon/env/runtime` entry point is removed.** It held
  `fetchEnvReusingSecrets`, which reads an env source and can mint and revoke branch credentials.
  Its only consumers were Neon's own CLIs, and a library that revokes your credentials because you
  imported it is one you cannot safely embed — so it is now internal shared source rather than a
  published path. If you were importing it, use the `neon` CLI (`neon env pull`, `neon dev`), which does this for you. Rolling your own is possible but the hard part is not storing the secret — it is **verifying** it: a persisted secret is only reusable if it still names a live credential on that branch, unrevoked, unexpired, and carrying every scope the policy needs. A presence check cannot tell a real secret from a `.env.example` placeholder, which is the bug 0.12.0 shipped a fix for. `credentialScopesSatisfied` and `deriveCredentialScopes` from `@neon/config/v1`, plus `listCredentials` / `createCredential` / `revokeCredential` on a `NeonApi`, are the pieces.

  Everything else is unchanged: `fetchEnv`, `parseEnv`, `toEntries` and `NEON_ENV_VAR_KEYS` stay on
  `@neon/env` with the same signatures, and the `neon-env` binary is unaffected.

- 4497de8: Refreshed `--help` text for project, branch, endpoint, and database flags from the current Neon OpenAPI spec. Several descriptions that rendered as empty now have text, and the scale-to-zero, history-retention, and provisioner flags describe their plan limits.
- Updated dependencies [3cb16e1]
- Updated dependencies [4497de8]
- Updated dependencies [35299c4]
  - @neon/config-runtime@1.0.0
  - @neon/sdk@2.0.0
  - @neon/config@1.0.0

## 2.47.0

### Minor Changes

- 6f8ba4d: `neon env pull` now pulls the AI Gateway variables (`NEON_AI_GATEWAY_TOKEN`, `NEON_AI_GATEWAY_BASE_URL`) when the working directory has no `neon.ts`, so a bare pull writes everything the branch can give you. A `neon.ts` still decides on its own, and the pull bundled into `link` / `checkout` / `config apply` is unchanged.

  New `--service` flag scopes a pull to `postgres`, `auth`, `data-api`, `object-storage`, and/or `ai-gateway`, overriding `neon.ts`. A scoped pull writes and prunes only within the services you name, so `neon env pull -s ai-gateway` leaves your `DATABASE_URL` alone.

  `neon dev` resolves the same set by the same rules, so a function running locally gets what the deployed runtime would inject — including the AI Gateway on a branch with no `neon.ts`. It also reads your `.env` / `.env.local` now to reuse the branch credential behind the AI Gateway and object storage, instead of minting one on every start.

  Every services flag in the CLI now shares one vocabulary and one syntax: `-s`, `--service` and `--services` are interchangeable, values can be repeated or comma-separated, and a service is spelled the same way on every command. That renames `neon config init --services storage` to `object-storage`; the old spelling still works and warns.

  `fetchEnvReusingSecrets` (`@neon/env/runtime`) takes a new `revokeSuperseded` option. It defaults to `true`, the existing behaviour. Pass `false` when the call resolves only part of what a branch has: object storage and the AI Gateway share one credential, so revoking the one your persisted secrets name can break a service the call is not rewriting. The credential it then leaves live is reported as `credential.superseded`, the counterpart to the existing `credential.revoked`.

### Patch Changes

- 47e6728: Install the config packages with the package manager the project actually uses

  `neon config init` (and the `neon link` prompt that runs it) picked a package manager from `npm_config_user_agent` alone, which is empty for a globally installed `neon`. It then fell back to the first manager on `PATH`, effectively always npm — so setting up a pnpm, yarn, or bun project shelled out to `npm install`. In a pnpm project that fails outright: npm's dependency resolver chokes on pnpm's symlinked `node_modules` with `Cannot read properties of null (reading 'matches')`. The install leaves a `neon.ts` whose `@neon/config/v1` import can't resolve, so the env pull that follows fails too.

  `resolvePackageManager` now reads the project's lockfile first, from the target directory and its parents up to the repo root — so a package in a monorepo finds the root lockfile, while a stray lockfile above the repository is ignored. A project with no lockfile falls back to the previous behaviour unchanged.

- Updated dependencies [6f8ba4d]
  - @neon/env@0.15.0

## 2.46.0

### Minor Changes

- ecd588f: `neon-init` is deprecated; its whole flow now lives in `neon init`

  `neon-init` was a second CLI shipping the setup flow that `neon init` already exposed — `neon`
  depended on it, imported five functions from it, and forwarded every command to it. Two
  published packages, two release dispatches, and two versions that could drift, for one command.

  The code moves into `packages/cli/src/init/` and the package is gone. `neon init` behaves as
  before: same phases, same `--data` step routing, same prompts, and it still reaches Neon by
  shelling out to `npx -y neon`.

  **The command is `npx neon init`.** `neon-init` is deprecated and gets no further releases;
  there is no alias package, because it was a CLI rather than a library and the command that
  replaces it is on a CLI its users already have. The `neon-init/bootstrap` subpath is gone too;
  that core is now internal to `neon`, and `neon bootstrap` is its supported surface.

  Two things about `neon init --agent` change, because deleting the standalone binary made it the
  only agent entry point and it was the weaker of the two:

  - **The JSON response goes to stdout, unprefixed.** It was written through the CLI's logger,
    which prefixes every line with `INFO: ` and writes to stderr — a diagnostic channel, for a
    payload agents are told to parse.
  - **A failure is JSON as well**, `{"success": false, "error": "…"}` on stdout with exit 1.
    Every error was previously swallowed by a bare `catch {}`: an agent got exit 1, empty stdout,
    and no way to tell a bad `--data` payload from a network failure. Without `--agent` the same
    error is one `ERROR: …` line on stderr.

  A damaged credentials file is the one failure that still reports on stderr under `--agent`: the
  auth middleware reads credentials before `init`'s skip in `ensureAuth`, so it fails before the
  command runs. It names the file and the repair either way.

### Patch Changes

- 4b9fd02: Emit `neon` instead of the removed `neonctl` binary name in help text, error hints, and `--agent` command templates, so suggested commands are runnable. When invoked via the `neonctl` compat package the commands still read `neonctl`.
- Updated dependencies [4b9fd02]
  - @neon/env@0.14.1
  - @neon/config@0.14.1
  - @neon/config-runtime@0.12.5

## 2.45.0

### Minor Changes

- f549c10: Fix WebSockets under `neon dev`. The dev server registered no `'upgrade'` listener, so
  Node handed a WebSocket handshake to the ordinary request handler and answered `200 OK` on
  a connection the client expected to be a `101` — a function's `upgrade` export was never
  called, and the failure looked like success.

  The dev server now handles upgrades the way the deployed runtime does: the existing
  `export function upgrade(req, socket, head)` shape works locally for the first time, and
  `upgradeWebSocket()` from `@neon/functions` works too, with the same precedence (a legacy
  `upgrade` export wins) and the same clean `501` for a function that serves no WebSockets.

### Patch Changes

- 304bc8f: Fix WebSocket serving under `neon dev`.

  - A function can now refuse a handshake by returning an ordinary `Response`. A `401`,
    `403` or `404` returned from `fetch` is relayed to the client with its status, headers
    and body intact, instead of being replaced by `501 websocket not supported by this
function`. Refusing an unauthenticated connection is the normal case for a WebSocket
    endpoint and there was previously no way to express it.
  - `CloseEvent` is only a Node global from v23, and this package supports Node >= 20.19,
    so every close path threw `ReferenceError: CloseEvent is not defined` on Node 20 and 22. It is now shimmed, alongside the existing `ErrorEvent` shim.
  - A malformed handshake is answered as the client error it is: an unsupported
    `Sec-WebSocket-Version` gets `426` with `Sec-WebSocket-Version: 13`, a
    `Sec-WebSocket-Key` that is not a base64-encoded 16-byte value gets `400`, and a
    non-`GET` handshake gets `405`. Previously all three reached the handler, threw, and
    were reported as `502 handler error`.
  - A flood of empty continuation frames no longer grows the reassembly buffer without
    bound; they add no bytes, so the byte ceiling never stopped them.
  - When the peer never answers a close, the close event now reports `1006` rather than
    the code this side sent.

## 2.44.0

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
  - @neon/env@0.14.0
  - neon-init@0.20.7
  - @neon/config@0.14.0
  - @neon/config-runtime@0.12.4

## 2.43.0

### Minor Changes

- 48b274f: Add `neon api-keys`, including project-scoped keys

  The CLI exposed no API-key management at all, so the only way to mint one was the console or a hand-rolled `neon api /organizations/{id}/api_keys -X POST`. All six endpoints are now covered:

  ```bash
  neon api-keys list                                        # your account's keys
  neon api-keys list --org-id org-…                         # an organization's, with scope shown

  neon api-keys create --name ci                            # account key
  neon api-keys create --name ci    --org-id org-…          # organization key
  neon api-keys create --name agent --project-id frosty-…   # can access only that project

  neon api-keys revoke <id> [--org-id org-…]
  ```

  **Project-scoped keys are the reason this matters.** A key created with `--project-id` cannot create projects, cannot mint API keys, and cannot see any other project — other projects return "not found" rather than a permission error, so it isn't even an existence oracle. It is not read-only — inside that project it can do anything the API allows, including deleting it. What it bounds is reach, which is what lets you hand it to an agent or a CI job without handing over your account (link the directory as yourself first; a scoped key cannot list projects to pick one):

  ```bash
  neon link --project-id frosty-…       # once, as yourself
  NEON_API_KEY=napi_… neon deploy       # then the agent, reaching only that project
  ```

  `--org-id` and `--project-id` are mutually exclusive: a project-scoped key is already an organization key, and its organization is looked up from the project rather than chosen separately. With neither flag you get an account key.

  `api-keys` is deliberately exempt from `.neon` context enrichment. Every other project command fills `--project-id` from the linked directory, which here would mean `api-keys create --name ci` silently producing a key scoped to whatever project is checked out instead of the account key requested. How far a credential reaches comes only from a flag you typed.

  `neon api-keys list --org-id` shows which keys are scoped and to what, reading `(all projects)` for keys that are not narrowed, alongside `last_used_at` and `last_used_from_addr` — the fields you need to spot a key worth revoking.

### Patch Changes

- 48b274f: Make `profiles` the primary spelling of the profile command group

  `profile` was primary with `profiles` as the alias, which is backwards from every other group — `projects`/`project`, `branches`/`branch`, `databases`/`database`. Both spellings continue to work.

  The group first appears in an unreleased version, so nothing depends on the old ordering.

- 7cbeead: Report a request timeout as a timeout, not as a broken internet connection.

  When the Neon API accepted a connection and then didn't answer within the 60s request
  timeout, the CLI printed:

  > Could not reach the Neon API. Please check your internet connection and try again.

  The connection was fine and the request had reached the server, so the one thing the
  message told the user to check was the one thing that was not wrong.

  The timeout is raised inside the CLI's own `fetch` wrapper, so by the time it is
  classified `@neon/sdk` has wrapped it as a `NeonNetworkError` — and the check looked only
  at the top-level error's `name`, which is `NeonNetworkError` on every SDK path. The
  timeout therefore fell through to the connectivity branch, whose message pattern matched
  the SDK's own `Network error: …` text. A timeout is now raised as a CLI-owned error type
  and recognised through the `cause` chain, so it reports `ECONNABORTED` and "Request timed
  out" as intended.

  `getApiClient` also accepts `requestTimeoutMs`, defaulting to the same 60s, which is what
  makes the behaviour testable against a server that never responds. It is validated when
  the client is built: without that, `-1`, `NaN`, `Infinity`, fractions and values above
  `4294967295` throw from inside the fetch wrapper and come back as the same misleading
  connectivity error, while `0` and the band from `2147483648` to `4294967295` are accepted
  and make every request time out at once.

- Updated dependencies [4fb2ea4]
- Updated dependencies [c8e1e74]
  - @neon/sdk@1.5.0
  - @neon/config@0.13.2
  - @neon/config-runtime@0.12.3
  - @neon/env@0.13.3

## 2.42.0

### Minor Changes

- 6648f8c: `neon config init --from-branch` seeds `neon.ts` from a branch's live Neon state instead of asking which services to declare. It uses the branch pinned in `.neon`, `--branch <name|id>`, or the project's default branch, and declares what the branch actually reports: Neon Auth, the Data API, and object-storage buckets with their access levels, plus the branch's compute settings in the policy closure.

  Three things it cannot declare are surfaced rather than guessed: deployed functions are listed as a commented-out block (the branch has no local `source` path), the AI Gateway is mentioned in a header comment (a branch has no readable enabled state for it), and a `protected` branch is reported as a comment instead of a policy field. `--from-branch` conflicts with `--services`, and it is the only mode of `config init` that calls the Neon API.

### Patch Changes

- Updated dependencies [923ebbb]
  - @neon/sdk@1.4.1
  - @neon/config@0.13.1
  - @neon/config-runtime@0.12.2
  - @neon/env@0.13.2

## 2.41.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [4b37fc8]
  - @neon/config@0.13.0
  - @neon/env@0.13.1
  - neon-init@0.20.6
  - @neon/config-runtime@0.12.1

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
