# Neon CLI

The `neon` package is a command-line interface that lets you manage [Neon](https://neon.com/) — Lakebase Postgres, Object Storage, Functions, Managed Better Auth, and the AI Gateway — directly from the terminal. For the complete documentation, see [Neon CLI](https://neon.com/docs/cli).

The legacy `neonctl` package is a lightweight compatibility package that depends
on this package and invokes the same CLI entry point. The implementation and
build artifacts live only here.

## Install the Neon CLI

**npm**

```shell
npm i -g neon
```

Requires Node.js 20.19 or higher.

**Howebrew**

```shell
brew install neonctl
```

**Binary (macOS, Linux, Windows)**

Download a `neon-<platform>` binary from the [releases page](https://github.com/neondatabase/neon-pkgs/releases), which carries one asset per platform for each `neon@<version>` tag.

### Upgrade

**npm**

```shell
npm update -g neon
```

Requires Node.js 20.19 or higher.

**Howebrew**

```shell
brew upgrade neonctl
```

**Binary (macOS, Linux, Windows)**

To upgrade a binary version, download the latest binary file, as described above, and replace your old binary with the new one.

## Connect

Run the following command to authenticate a connection to Neon:

```bash
neon auth
```

The `auth` command launches a browser window where you can authorize the Neon CLI to access your Neon account. Running a Neon CLI command without authenticating with [neon auth](https://neon.com/docs/cli/auth) automatically launches the browser authentication process.

Alternatively, you can authenticate a connection with a Neon API key using the `--api-key` option when running a Neon CLI command. For example, an API key is used with the following `neon projects list` command:

```bash
neon projects list --api-key <neon_api_key>
```

For information about obtaining an Neon API key, see [Authentication](https://neon.com/docs/reference/api/get-started), in the _Neon API Reference_.

## Create a project without an account

`neon claim create` provisions a temporary Claimable Neon project for an agent without
requiring a Neon account or opening a browser:

```bash
# Lakebase Postgres is always included
neon claim create

# Request Managed Better Auth and the Data API too
neon claim create --service auth --service data-api
```

When the current directory has a `neon.ts`, `claim create` also requests every service
declared there. Explicit `--service` values are added to that set. Object Storage, Functions,
and the AI Gateway are sent to the service so demand is recorded, but are reported as
unavailable until the project is claimed; the CLI does not silently remove them.

The command writes:

- a `.neon` context that identifies the project and Claimable Neon service;
- an owner-only identity assertion under the CLI config directory;
- `DATABASE_URL` and any granted Auth or Data API variables to `.env` or `.env.local`
  (disable this with `--no-env-pull`).

Subsequent project commands automatically exchange the assertion for a short-lived agent
token and send API calls to Claimable Neon. The service decides which operations are
allowed before claim.

```bash
neon claim status                 # lifecycle and transfer status
neon projects get <project-id>    # regular CLI command, same agent token
neon psql --role-name neondb_owner -- -c "select now()"
neon config plan
neon env pull --service postgres --service auth --service data-api

neon claim accept                 # create a claim code and open the transfer URL
neon claim delete --yes           # permanently delete an unclaimed project
neon claim list                   # local records, including expired
neon claim delete <project-id> --yes
```

`status`, `accept`, and `delete` take an optional project id from `claim list`, so a
project stays manageable after its original directory is gone. `list` prints `state`
(`unclaimed` or `expired`) from the identity assertion clock and the project
expiry, plus `project_expires_at`. `delete` also drops a
local record whose identity assertion has expired or been revoked.

`neon claimable` is an alias for `neon claim`. For local service development, set
`CLAIMABLE_NEON_HOST=http://localhost:8787`; non-local origins must use HTTPS.

## Project and branch creation

Choose the PostgreSQL version when creating a project:

```bash
neon projects create --name my-project --pg-version 18
```

Supported versions are `14` through `19`; version `19` is available only in
regions where it has been enabled.

Create a protected branch when it should not be modified or deleted by routine
automation:

```bash
neon branches create --project-id <project-id> --name production --protected
```

Project and branch creation include connection credentials in their output by
default for backward compatibility. When the output may be logged or passed to
an agent, use `--no-secrets` to return only the created resource metadata:

```bash
neon projects create --name my-project --output json --no-secrets
neon branches create --project-id <project-id> --name preview --output json --no-secrets
```

The flag omits the complete `connection_uris` block rather than redacting one
field. Retrieve a connection string separately when it is actually needed.

### Enable logical replication

Enable logical replication for every endpoint in an existing project:

```bash
neon projects update <project-id> --enable-logical-replication
```

The CLI asks for confirmation because enabling logical replication suspends
active endpoints and cannot be undone. For non-interactive automation, pass
`--yes` explicitly:

```bash
neon projects update <project-id> --enable-logical-replication --yes
```

## Connect with psql

### The `psql` command

`neon psql [branch]` opens a psql session against a branch. It builds the connection string for the branch and launches psql — a shortcut for `neon connection-string --psql`. See [Neon CLI commands — psql](https://neon.com/docs/cli/psql) for the full reference.

```bash
neon psql                                    # default branch
neon psql main                               # a specific branch
neon psql main@2024-01-01T00:00:00Z          # point-in-time (branch@timestamp or branch@lsn)
neon psql --pooled                           # use the pooled connection
```

Arguments after `--` are forwarded to psql:

```bash
neon psql main -- -c "SELECT version()"
neon psql main -- -f script.sql --csv
```

Options: `--project-id`, `--role-name`, `--database-name`, `--pooled`, `--endpoint-type` (`read_only` | `read_write`), `--ssl`, plus the [global options](#global-options).

### The `--psql` flag

Several other commands accept a `--psql` flag that opens a psql session against the resolved endpoint:

```bash
neon connection-string --psql --project-id <id>
neon projects create --psql
neon branches create --psql
```

Any arguments after `--` are forwarded to psql, for example:

```bash
neon cs --psql --project-id <id> -- -c "SELECT version()"
neon cs --psql --project-id <id> -- -f script.sql --csv
```

### Embedded psql fallback

If the system has `psql` installed on `$PATH`, `--psql` continues to spawn the native binary — there is no behavior change for existing users.

If `psql` is not found on `$PATH`, neon now falls back to an embedded TypeScript implementation. There is nothing to install or configure; it ships with `neon`. This removes the "no psql binary" trap on machines (and CI runners) that don't have PostgreSQL client tools installed.

Automatic fallback is the intended path — there is normally no flag to set. The embedded implementation can also be force-selected (primarily for tests and CI, e.g. to exercise it even when a native `psql` is present):

- `--fallback` — force the embedded implementation on `connection-string`, `projects create`, and `branches create`. Intentionally hidden from `--help`: it's a test/CI knob, not a user-facing option (the automatic fallback above is the supported behavior).
- `NEONCTL_PSQL_FALLBACK=1` — environment variable with the same effect as `--fallback`. Convenient for scripts and CI.

The embedded implementation is verified against a conformance suite that
diffs its behavior against real PostgreSQL (14–18) and the upstream psql
regression + TAP tests.

#### What works

**REPL & scripting**

- Interactive REPL with a hand-rolled VT100 line editor (no native bindings); vi and emacs edit modes (`VI_MODE` psql variable)
- Persistent command history (`~/.psql_history`, libreadline format)
- `~/.psqlrc` autoload (including `$PGSYSCONFDIR/psqlrc` and version-suffixed variants)
- Scripted modes: `-c "SQL"`, `-f script.sql`, and stdin; `--single-transaction`, `ON_ERROR_STOP`, `ECHO`, `--echo-all`
- `SINGLELINE` (`-S`), `\timing`, `\watch` (named flags `c=`/`i=`/`m=`, unbounded continuous mode)

**Backslash commands**

- All output formats: aligned, unaligned, wrapped, csv, json, html, asciidoc, latex, latex-longtable, troff-ms (`\a \H \t \x \pset \f \C` …)
- All `\d*` describe commands with full upstream parity (columns, indexes, foreign keys, triggers, view definitions, sequences, RLS, replica identity, partitions, tablespaces, access methods, inheritance, FDW, stats objects, publications, subscriptions, per-column FDW options, TOAST owner)
- `\copy` to/from file, `PROGRAM`, `STDIN`, `STDOUT` (incl. the `\.` EOF marker); `\g` / `\gx` / `\gset` / `\gdesc` / `\gexec` and `\g | program` pipes
- Extended query + pipeline mode (`\bind`, `\bind_named`, `\startpipeline`, `\parse`, `\sendpipeline`)
- `\crosstabview`, `\lo_*` large objects, `\e`/`\edit` (external editor), `\s` (history), `\?`/`\h` help, `\if`/`\elif`/`\else`/`\endif`, `\set`/`\unset`, `\connect`, `\encoding` (live `SET client_encoding`), `\!`, `\cd`, `\prompt` (incl. no-echo `-`), `\password`
- Tab completion (~88 rules incl. live `pg_settings` GUC lookup, deep `ALTER` sub-actions, `JOIN` clauses, window `OVER`)

**Connection & authentication**

- libpq-equivalent lookup precedence: argv flags > URI > `PG*` env vars > `~/.pgpass` > `pg_service.conf` > libpq defaults
- SCRAM-SHA-256 / SCRAM-SHA-256-PLUS with `tls-server-end-point` channel binding (`channel_binding`); MD5 and cleartext; `require_auth`
- Multi-host failover & load balancing: `target_session_attrs` (any / read-write / read-only / primary / standby / prefer-standby), `load_balance_hosts`, DNS fan-out, `hostaddr`
- Unix-domain sockets (host beginning with `/`); TCP keepalives (`keepalives`, `keepalives_idle`)

**TLS**

- `sslmode` disable → verify-full; client certs in **PEM or DER** via `sslcert` / `sslkey` (+ `sslpassword` for encrypted keys, with the libpq group/world-readable-key check)
- Trust config: `sslrootcert` (incl. `=system` with `SSL_CERT_FILE` / `SSL_CERT_DIR`), default client-cert discovery (`~/.postgresql/postgresql.{crt,key}`), `sslcertmode`
- CRL: `sslcrl` and `sslcrldir`; `ssl_min_protocol_version` / `ssl_max_protocol_version`; `sslsni`
- Direct-SSL negotiation (`sslnegotiation=direct`, PostgreSQL 17+, via ALPN)

#### What's not supported

- **GSSAPI / SSPI** (`gssencmode`, Kerberos/SSPI auth, `requirepeer`). GSS transport encryption needs a native Kerberos binding, which the embedded psql deliberately avoids (pure TypeScript, zero native dependencies — the same reason the line editor is hand-rolled). `node-postgres` doesn't support it either, and Neon doesn't use it. `gssencmode=disable` / `prefer` are accepted; `gssencmode=require` is rejected with a clear error. `requirepeer` is parsed but a Unix-socket connection that sets it is refused (Node exposes no peer-credential API — it is not silently ignored).
- **`keepalives_interval` / `keepalives_count`** — Node's socket API exposes only keepalive enable + initial delay, so these are accepted but not applied.

### Known limitations

- **TLS cipher is runtime-dependent.** The negotiated TLS 1.3 ciphersuite is chosen by the host runtime's TLS library from an offer byte-identical to libpq's. Under Node (OpenSSL) that is `TLS_AES_256_GCM_SHA384`, matching vanilla psql; under Bun (BoringSSL) it is `TLS_AES_128_GCM_SHA256`. Both are TLS 1.3 AEAD suites with no practical security difference, and neither runtime exposes a client-side knob to steer the selection.

## Configure autocompletion

The Neon CLI supports autocompletion, which you can configure in a few easy steps. See [Neon CLI commands — completion](https://neon.com/docs/cli/completion) for instructions.

## Linking a project

`neon link` is a Vercel-style command that binds the current directory to a Neon project. It picks (or creates) an organization and a project and writes a `.neon` file (`{ "orgId", "projectId", "branch" }`) that subsequent commands run in this directory (or any sub-directory) pick up automatically.

`link` resolves what it can and **verifies every identifier you pass** before writing, so a `.neon` is never left half-written or pointing at something that doesn't exist:

- **org** is inferred from the project (so `--project-id` alone is enough); it's omitted only when the project has no organization (personal account).
- **project** is taken from `--project-id` (or chosen interactively).
- **branch** is taken from `--branch`, an existing pin for the same project, or the project's branch list: one branch is pinned automatically; several prompt in a TTY, pin the default with `-y`, or stay unpinned for [`neon checkout <branch>`](#checkout). A project with no branches is linked without a pin and says so.

When a branch ends up pinned, `link` also runs [`env pull`](#env-pull) so the branch's Neon env vars (`DATABASE_URL`, …) land in a local `.env`. With no branch pinned there is nothing to pull, so `link` instead nudges you to run `neon checkout`. Pass `--no-env-pull` to skip the pull (for example when injecting env at runtime with `neon-env run` or `neon dev`).

> **Migrating from `set-context`?** `set-context` is **deprecated** in favor of `link` (see [below](#set-context-is-deprecated)). It still works exactly as before for now (a raw write), it just prints a deprecation warning. The `.neon` `branchId` field is also superseded by `branch` (which stores the branch **name** when known); old `branchId` files are still read and are upgraded to `branch` the next time `link`/`checkout` writes the context.

There are two modes:

**Interactive (default)** — guided prompts for humans:

```bash
$ neon link
? Which organization would you like to link? › Personal Org (org-abc123)
? Which project would you like to link? › ＋ Create new project…
? Name for the new project: › my-app
? Which region should the new project run in? › AWS US East (Ohio) (aws-us-east-2)
Created project polished-snowflake-12345678 ("my-app") in aws-us-east-2.
Linked .neon:
  orgId:     org-abc123
  projectId: polished-snowflake-12345678
  branch:    main
```

When you link an **existing** project that has more than one branch, the interactive flow adds a
final step to pick which branch to pin — the same `＋ Create a new branch…` + list selector used by
`neon checkout` (a single-branch project is pinned automatically, no prompt):

```bash
$ neon link
? Which organization would you like to link? › Personal Org (org-abc123)
? Which project would you like to link? › my-app (polished-snowflake-12345678)
? Which branch would you like to link? › [default] main (br-main-branch-87654321)
```

`link --project-id …` skips org and project. One branch is pinned with no prompt. Several branches
in a TTY show the branch prompt; `-y` pins the default; no TTY leaves the pin empty for
`neon checkout`:

```bash
$ neon link --project-id polished-snowflake-12345678
? Which branch would you like to link? › [default] main (br-main-branch-87654321)
```

**Non-interactive (flags or `--params` JSON)** — for scripts and CI:

```bash
# Link to an existing project (org is inferred). Pins the only branch;
# several branches prompt in a TTY, or stay unpinned without one.
neon link --project-id polished-snowflake-12345678

# Same, pin the project's default branch when several exist
neon link --project-id polished-snowflake-12345678 -y

# Same, but also pin a branch (name or id — resolved and stored as its name)
neon link --project-id polished-snowflake-12345678 --branch main

# Pin/switch the branch in the already-linked project
neon link --branch main          # alias: --branch-id

# Create a new project and link it (pins the new project's default branch)
neon link --org-id org-abc123 --project-name my-app --region-id aws-us-east-2

# Same payload, one JSON blob
neon link --params '{"orgId":"org-abc123","projectName":"my-app","regionId":"aws-us-east-2"}'

# Record just the default org (preserves any existing project/branch)
neon link --org-id org-abc123

# Forget the current context
neon link --clear

# Offline write — no API calls, no verification (see --no-checks below)
neon link --no-checks --org-id org-abc123 --project-id polished-snowflake-12345678
```

Every supplied identifier is checked before anything is written, with actionable errors — e.g. `Project '…' not found`, `You don't have access to project '…'`, `Organization '…' not found, or your API key doesn't have access to it`, `Project '…' belongs to organization 'A', not 'B'`, or `Branch '…' not found in project '…'. Available branches: …`.

**Agents and scripts (no TTY):** List, then link. `neon link --help` prints the same recipe.

```bash
neon orgs list --output json
neon projects list --org-id <org-id> --output json
neon link --project-id <project-id> [--branch <name> | -y]
neon link --org-id <org-id> --project-name <name> --region-id aws-us-east-2
```

Organization-scoped API keys cannot list user organizations (`orgs list`) or call the regions endpoint:

- Pass `--org-id` (Neon Console → Settings) or `--project-id` (org is inferred from the project).
- If the key is org-scoped and at least one project already exists, interactive `link` auto-detects the org from the first project and prints an informational message.
- If no projects exist yet, interactive `link` errors pointing at `--org-id`.
- When the regions endpoint is not allowed, interactive create falls back to a built-in static region list. Non-interactive create already requires `--region-id`.

**Offline writes (`--no-checks`)** — write the `.neon` with no API calls at all: no org inference, no existence/access verification, no env pull. Because nothing can be resolved offline, it requires both `--org-id` and `--project-id` (`--branch` optional, stored verbatim). Handy for scripted/CI setups or re-creating a `.neon` from values you already trust:

```bash
neon link --no-checks --org-id org-abc123 --project-id polished-snowflake-12345678 --branch main
```

#### `set-context` is deprecated

`set-context` is **deprecated** in favor of `link` and prints a deprecation warning (to stderr, so it never pollutes stdout or scripts). For backward compatibility its behavior is **unchanged**: it's still a raw, offline write of exactly the fields you pass (no org inference, no verification, no env pull), and bare `set-context` still clears the file. Nothing breaks today — but new work should use `link`, and `set-context` will be removed in a future major release.

How today's `set-context` uses map onto `link`:

| `set-context` (deprecated)              | Recommended `link` equivalent                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `neon set-context --project-id <id>` | `neon link --project-id <id>` (infers org + verifies; pins the only branch) |
| `neon set-context --org-id <id>`     | `neon link --org-id <id>`                                                  |
| `neon set-context --branch-id <id>`  | `neon link --branch <name\|id>`                                            |
| `neon set-context` (clear)           | `neon link --clear`                                                        |
| a raw local write (no network)          | `neon link --no-checks --org-id <id> --project-id <id>`                    |

The key difference: `link` resolves and **verifies** before writing (so you never get a half-written or stale `.neon`), whereas `set-context` writes whatever you give it verbatim. The closest like-for-like replacement for the old raw write is `link --no-checks`.

### open

`open` launches the linked project's page in the Neon Console. It reads the closest `.neon` file without authenticating or calling the Neon API, so it works from any sub-directory of a linked project.

```bash
neon open

# Open a project without changing the linked context
neon open --project-id polished-snowflake-12345678
```

A branch pinned in `.neon` does not change the destination. `.neon` stores the branch as a name, while the Console route requires its ID; resolving it would turn this local command into an authenticated API call.

### checkout

`checkout [id|name]` pins a branch in the local context so subsequent commands target it — it's the focused companion to `link` for the common "switch the branch I'm working on" case (`link` resolves org + project; `checkout` pins the branch). It resolves the branch (by name or id) against the project, then **heals** the `.neon` file: it always (re)writes `projectId`, `branch`, and `orgId` (when the project has one), so a `.neon` that was missing fields or drifted ends up complete and consistent. The branch is stored as its **name** when known (matching `link`). When `orgId` isn't already known (from `--org-id` or the existing `.neon`), it's looked up from the project itself.

The branch argument is **optional**: run `neon checkout` with no branch in an interactive terminal to fetch the project's branches and pick one from a list. In a non-interactive context (CI or no TTY), a branch must be passed explicitly.

Branch **id vs name** is detected automatically (a `br-…` value is treated as an id):

- **id** — matched strictly by id. A non-existent id is a hard "not found" error (ids are server-assigned, so checkout never creates one).
- **name** — matched by name. If the name doesn't exist, in an interactive terminal `checkout` offers to **create** it (equivalent to `neon branch create --name <name>`: branched from the project's default branch with a read-write compute), then checks it out. In a non-interactive context a missing name is the usual "not found" error.

The project is resolved through the standard neon chain, each entry winning over the next:

1. `--project-id <id>` flag
2. `projectId` from the closest `.neon` file (found by walking up from the current directory — see "Where `.neon` lives" below)
3. If still unresolved and the API key maps to exactly one project, that project is auto-detected (same behaviour as `branches` and `connection-string`)

If none of those resolve a project, `checkout` prints a telling error explaining the chain above. In an interactive terminal it then offers to run `neon link` in the current folder so you can pick (or create) a project on the spot; once linked, it continues and pins the requested branch. In non-interactive contexts (CI or no TTY) it exits with a non-zero code and the same guidance instead of prompting.

The resolved branch is then written (by name) to the same `.neon` file `link` uses:

```bash
$ neon checkout main --project-id polished-snowflake-12345678
INFO: Checked out branch br-main-branch-87654321 on project polished-snowflake-12345678. Updated /path/to/cwd/.neon.

$ cat .neon
{
  "orgId": "org-abc123",
  "projectId": "polished-snowflake-12345678",
  "branch": "main"
}
```

After pinning the branch, `checkout` also runs [`env pull`](#env-pull) by default, so the branch's Neon env vars are written to your local `.env` and you can start building right away — the branch-first loop is just `link` + `checkout`. Pass `--no-env-pull` to skip it (for example when env is injected at runtime via `neon-env run` / `neon dev`, or to keep secrets out of the working tree). A pull failure never undoes the checkout: the branch stays pinned and the failure is surfaced as a warning pointing you at `neon env pull` (or `neon deploy` if a `neon.ts`-declared service is missing).

### diff

`diff [compare-branch]` prints a **git-style** schema diff between the branch you're on and another branch — the top-level companion to `checkout`. It reads the branch pinned in `.neon` as the side under review (the `+++` side) and compares it against the branch you name (the `---`, reference side), so `+` lines are what your current branch adds on top of the reference:

```bash
# On feature/add-comments (pinned in .neon), see how it differs from main:
$ neon diff main
→ Comparing schema main → feature/add-comments
diff --neon database neondb
--- main (br-crimson-snow-12345678)
+++ feature/add-comments (br-dry-salad-87654321)
@@ -63,7 +64,8 @@
 CREATE TABLE public.users (
     id integer NOT NULL,
     email text NOT NULL,
-    created_at timestamp with time zone DEFAULT now()
+    created_at timestamp with time zone DEFAULT now(),
+    display_name text
 );
```

- **`compare-branch`** is optional. Omit it to compare the current branch against its **parent** (`neon diff` answers "what did I change since branching?"). It accepts a branch **name** or `br-…` **id**.
- **`--branch, -b <name|id>`** overrides the side under review instead of reading `.neon` — e.g. `neon diff main --branch feature/checkout` diffs an explicit branch against `main`.
- **`--database, --db <name>`** limits the diff to one database; by default every database on the current branch is compared (each rendered as its own `diff --neon database <name>` block). A database missing on the reference side shows as fully added.
- **`--output json|yaml`** emits a structured result per database (`{ database, base_branch, compare_branch, has_changes, diff }`) for scripting; the default renders the colorized git-style diff (respecting `--no-color` and non-TTY pipes).

The human-readable summary line goes to stderr and the diff body to stdout, so `neon diff main > changes.patch` captures just the diff. When the schemas match, `diff` prints `No schema differences …` and writes nothing to stdout. For history-aware comparisons (a branch against its own past state at a timestamp or LSN), use [`branches schema-diff`](https://neon.com/docs/reference/cli-branches#schema-diff).

### env pull

`env pull` writes the linked branch's Neon environment variables into a local dotenv file: an existing `.env` if you have one, otherwise `.env.local` (override with `--file <path>`). Only Neon-managed keys are written (see the table below); any other lines in the file are preserved. The branch comes from the closest `.neon` file, so no `--branch` is needed (pass `--branch <id|name>` to target another branch).

**What gets pulled**, in precedence order:

1. **`--service` and/or `--env`**, when you pass either — their union is the complete selection, ignoring `neon.ts` and unselected branch variables. `--service` adds a service's complete variable bundle; `--env` adds only the individual variables you name.
2. **`neon.ts`**, when the working directory has one — the policy is the source of truth, same as `neon dev` and `neon deploy`.
3. **Everything the branch has** otherwise — Postgres, Neon Auth, the Data API, and object storage read back from the branch, plus the AI Gateway. The gateway has no branch-level state to read back, so a bare `env pull` asks for it rather than detecting it and may mint a branch credential. To leave it out, name only what you do want with `--service` and/or `--env`.

If the gateway can't be resolved, it is dropped with a warning and the rest of the pull still lands. Gateway variables already in your file for *this* branch are left alone — a pull that couldn't reach the gateway is no evidence the branch has stopped having one — while ones left over from a different branch are pruned like any other stale value.

```bash
# Refresh the linked branch's vars in place
neon env pull

# Pull a specific branch into a specific file
neon env pull --branch preview --file .env.preview

# Only the AI Gateway
neon env pull --service ai-gateway

# Repeat the flag or comma-separate; -s, --service and --services are all accepted
neon env pull -s postgres -s data-api
neon env pull -s postgres,auth

# Pull one exact variable; repeat -e or comma-separate for more
neon env pull -e DATABASE_URL
neon env pull -e DATABASE_URL,NEON_AUTH_BASE_URL

# The selectors compose as a union: all Auth vars plus DATABASE_URL
neon env pull -s auth -e DATABASE_URL
```

Every services flag in the CLI takes those three spellings, the same value syntax, and the same service names — see [`config init --services`](#getting-a-neonts-config-init).

| `--service` | Variables |
| --- | --- |
| `postgres` | `DATABASE_URL`, `DATABASE_URL_UNPOOLED` |
| `auth` | `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL` |
| `data-api` | `NEON_DATA_API_URL` |
| `object-storage` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION` |
| `ai-gateway` | `NEON_AI_GATEWAY_TOKEN`, `NEON_AI_GATEWAY_BASE_URL` |

`-e, --env` accepts any variable in the table plus `NEON_BRANCH`. It is case-sensitive and rejects unknown names rather than silently widening the pull. `NEON_BRANCH` is written by unscoped and service-scoped pulls because it is branch identity, not a service; an env-only pull writes it only when you select it.

`--env` never narrows `--service`: `neon env pull -s postgres -e DATABASE_URL` still pulls the complete Postgres bundle (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and `NEON_BRANCH`). The two selectors always form a union.

**A scoped pull is scoped in both directions.** An unscoped `env pull` owns the Neon-named variables: pointing a directory at a branch without Neon Auth prunes the stale `NEON_AUTH_*` lines. `--service` narrows that to the services you named, while `--env` narrows it to the exact keys you named, so `env pull -e DATABASE_URL` never touches `DATABASE_URL_UNPOOLED`. (`AWS_*` is never pruned by any pull: those names collide with credentials you may set yourself, so `env pull` only ever writes them.)

**A scoped pull also never revokes a credential.** Where an unscoped pull revokes the credential it replaces, a scoped one leaves the old one live — it can't tell which other variables still use it. It says so when it happens; revoke it in the Neon Console if nothing does.

`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` must be selected together. Neon issues them as one object-storage credential; pulling only one would pair a fresh half with whatever old half remains in the file.

Naming a service the branch does not have is an error, not an empty pull:

```
--service auth: branch br-snowy-frost-12345 has no Neon Auth integration, so there are no
auth env vars to pull. Provision it first (`neon deploy`, `neon config apply`, or the Neon
Console), or drop auth from --service.
```

`link`, `checkout`, and `config apply` invoke `env pull` automatically (see above). Those bundled pulls follow rules 2 and 3 above **without** the implied AI Gateway: minting a credential for a service you never named isn't something a side effect of another command should do. Run `neon env pull` to get it.

If you'd rather not keep env vars on disk, inject them at runtime instead with `neon-env run -- <your dev command>` (from `@neon/env`) or `neon dev`, and pass `--no-env-pull` to `link` / `checkout`.

**`neon dev` resolves the same set, by the same rules** — including the AI Gateway on a branch with no `neon.ts`. A function running locally gets what the deployed runtime would inject into it, which is the whole point of `dev`; a handler that reads `NEON_AI_GATEWAY_BASE_URL` should not work in production and fail on your machine. `dev` writes nothing, but it does *read* your `.env` / `.env.local` to reuse the branch credential behind the AI Gateway and object storage. Without a file to read from it issues one on every start and leaves the last one live — it has nowhere to keep it, and so cannot name it to revoke it. It says so when it happens; run `env pull` (or just `link` / `checkout`) once and restarts reuse the credential instead.

**Where `.neon` lives**: `link` writes `.neon` into the **current working directory** by default. If an existing `.neon` is found in any parent directory, that file is reused — so commands run from a sub-directory of a linked project still pick up the project's context. To pin the location explicitly, pass `--context-file <path>`.

**`.gitignore` scaffolding**: when `.neon` is **created** for the first time, the CLI also makes sure a `.gitignore` sits alongside it listing `.neon`. If `.gitignore` doesn't exist it's created with a single `.neon` line; if it does exist, `.neon` is appended only when missing (no duplicates, your other entries are left alone). On subsequent updates to an existing `.neon`, `.gitignore` is left untouched — so if you deliberately un-ignore `.neon` (e.g. to commit shared context), the entry is not re-added on every command.

## Config as code (`config` / `deploy`)

Describe a branch's desired state in a `neon.ts` policy and reconcile it from the CLI — the Neon equivalent of `terraform status` / `plan` / `apply`. A policy splits into a **static** existential set — top-level `auth` / `dataApi` toggles and the beta `preview` block (Functions, buckets, AI Gateway) that decide what _exists_ — and a **dynamic** `branch` closure that tunes each branch (compute settings, TTL, protection, `parent`) based on the branch it's evaluated for (`name`, `isDefault`, …):

```ts
// neon.ts
import { defineConfig } from '@neon/config/v1';

export default defineConfig({
  // Static: what exists on every branch (drives the typed env).
  auth: true,
  // Dynamic: per-branch tuning only — cannot add/remove services.
  branch: (branch) => {
    if (branch.isDefault) {
      return { protected: true };
    }
    return { parent: 'main', ttl: '7d' };
  },
});
```

### Getting a `neon.ts` (`config init`)

`neon config init` scaffolds the policy and installs `@neon/config` / `@neon/env`, so a project can go straight to `plan` / `apply`. It is purely local — no auth, no API calls. In an interactive terminal it asks which services the policy should declare:

```
? Which Neon services should neon.ts declare? (space to toggle, enter to confirm) ›
◯   Managed Better Auth
     Authentication with users and sessions stored in Postgres.
◯   Functions
     Long-running, without timeouts, and closer to your database.
◯   Object Storage
     S3-compatible blob storage that branches with your projects.
◯   AI Gateway
     All models, one API, one bill. Powered by Databricks. Not available on the Neon free plan.
```

Selecting nothing is a valid answer: you get the starter policy, which is also what a non-interactive run (CI, no TTY) writes. Pass `--services` to skip the prompt anywhere:

```bash
# Pick interactively (TTY) or take the starter policy (CI)
neon config init

# Declare services with no prompt
neon config init --services auth,functions,object-storage,ai-gateway

# Repeat the flag instead, and shorten it — every services flag takes all three spellings
neon config init -s auth -s functions

# Explicitly ask for the bare starter policy
neon config init --services none

# Scaffold but print the install command instead of running it
neon config init --no-install
```

Object storage is spelled `object-storage` here, matching [`env pull --service`](#env-pull) and the rest of the CLI. The old `storage` still works and warns; it will be removed.

Choosing **Functions** also writes the handler the policy points at, since `source` is only resolved when `apply` bundles it — a declared function with no file on disk fails at deploy:

```ts
// hello.ts
export default async function hello(): Promise<Response> {
  return new Response('Hello from Neon Functions');
}
```

An existing `neon.ts` (or `hello.ts`) is never overwritten.

Four sub-commands plus two top-level aliases drive it:

```bash
# Scaffold a neon.ts and install the config packages (local only)
neon config init

# Inspect the branch's live Neon state (read-only — never mutates)
neon config status

# `neon status` is an alias for `neon config status`
neon status

# Dry-run diff: show exactly what `apply` would change
neon config plan

# Reconcile the policy against the branch
neon config apply

# `neon deploy` is an alias for `neon config apply`
neon deploy
```

**Project & branch resolution** follows the same chain as the rest of the CLI, each entry winning over the next:

1. `--project-id <id>` flag
2. `projectId` from the closest `.neon` file (found by walking up from the current directory — see "Where `.neon` lives" above)
3. If still unresolved and the API key maps to exactly one project, that project is auto-detected

The branch is chosen with `--branch <id|name>`; without it the project's default branch is used. The policy itself is found by walking up from the current directory for a `neon.ts`, or pass `--config <path>` to point at one explicitly.

**Apply-only flags** (also available on `deploy`):

- `--update-existing` — auto-confirm overriding existing remote settings on the branch. Without it, drift on settings already present remotely (compute, TTL, `protected`) is reported as a **conflict** and `apply` makes no changes until you resolve it or pass this flag.
- `--allow-protected` — auto-confirm applying to a branch Neon marks as protected. Without it, `apply` refuses to touch a protected branch.

**Output**: `status` prints the project, branch, and reverse-engineered config. `plan` / `apply` render a **`git diff`-style report** (matching [`neon diff`](#diff)): service changes (Neon Auth, Data API, buckets, functions) list as green `+` additions, while **branch setting changes** (TTL, `protected`, compute) show grouped under a `~ <branch>` header, one sorted `field → value` line each. A bare `apply` that hits drift on settings already present remotely prints those as a sorted **before→after** diff (`current → desired`, old in red / new in green) and exits non-zero until you pass `--update-existing`. Pass `--output json` (or `--output yaml`) to emit the full machine-readable result (`PushResult`) instead, for piping into other tools or CI.

**`config status --current-branch`** (alias `neon status --current-branch`) prints _only_ the branch pinned in the local `.neon` file — no network, no auth, no analytics — and exits non-zero when none is pinned. This behavior lets it safely drive a shell prompt. Example [starship](https://starship.rs) segment:

```toml
[custom.neon]
description = "Current Neon database branch"
format = "[$symbol$output]($style) "
style = "bold green"
# `symbol` below uses a Nerd Font glyph; swap it for a plain
# label/emoji if you don't have a Nerd Font installed.
symbol = " "
command = "neon status --current-branch"
# Starship evaluates this on EVERY prompt render. To keep prompts instant
# everywhere outside a Neon project, do a zero-subprocess walk-up for an
# ancestor `.neon` first (the same walk the CLI does, stopping at $HOME and /).
# Only when one is found do we invoke the CLI, whose exit code is the real
# gate: non-zero (no branch pinned) hides the segment cleanly.
when = '''
d="$PWD"
while [ "$d" != "$HOME" ] && [ "$d" != / ]; do
  if [ -e "$d/.neon" ]; then
    neon status --current-branch >/dev/null 2>&1
    exit $?
  fi
  d=$(dirname "$d")
done
exit 1
'''
```

```bash
# CI gate: fail the build if the branch has drifted from the policy
neon config plan --project-id polished-snowflake-12345678 --output json

# Reconcile a feature branch, overriding any manual tweaks made in the console
neon deploy --branch my-feature --update-existing
```

Function deploys declared under `preview.functions` are bundled with esbuild by default. A directory `source` is discovered as `index.ts`, then `index.js`, then `index.mjs`. Set `bundler: "none"` to ship a prebuilt directory as-is. `neon function deploy --no-bundle` is the same switch without a `neon.ts`.

When a package cannot be bundled — a native addon with no esbuild loader, or an optional peer dependency a library references on an untaken code path — list it in that function's `externalPackages` and the bundler leaves the import alone. `neon dev` honours the same list. It does not make the package resolvable in the deployed archive (there is no `node_modules` next to the bundle), so it only unblocks an import that is never evaluated — a dependency the handler actually calls has to be bundled, and a natively-backed one cannot be. See [`@neon/config`](../config/README.md#unbundleable-dependencies-externalpackages).

## Scaffold a project (`bootstrap`)

`neon bootstrap` copies a Neon starter template into a new (or current) directory — conceptually like `degit`, but it only pulls from a small set of templates we maintain in the public [`neondatabase/examples`](https://github.com/neondatabase/examples) repo. The template copy needs no Neon login: it downloads files from GitHub.

After scaffolding, an interactive terminal asks about dependency install, git, agent tooling (the Neon plugin, or skills and MCP separately — never both), and `neon link` before running those steps. Dependency install is last, except when the template has a `neon.ts` and you chose to link — then install runs first so link can pull env. `--default` / `-y` skips the template, install, git, and agent pickers, then installs agent tooling for project folders, else the host CLI agent. If none are found, it exits: pass `--agent <name>`, run from a supported agent, or omit `--default` / `-y` in a terminal to pick. `--agent` / `-a` names coding agents, skips agent selection, and is forwarded to `plugins`, or to `skills` and `mcp`, not both. `link --yes` still asks for a project unless one is already linked. `--no-agent-setup` and `--no-link` skip those. Non-interactive without `--default` prints next steps and does not install, set up agents, or link.

Pass a target directory (or `.` for the current one). In an interactive terminal you pick the template from a list; in CI / non-interactive contexts pass `--template <id>`.

```bash
# Pick a template interactively and scaffold it into ./my-app
$ neon bootstrap my-app

# Scaffold a specific template into the current directory (skips the template picker)
$ neon bootstrap . --template hono

# Skip agent selection; install the plugin for those agents
$ neon bootstrap my-app --agent cursor --agent claude-code

# List templates
$ neon bootstrap --list-templates

# Machine-readable catalog
$ neon bootstrap --list-templates --output json
```

The target directory must be empty unless you pass `--force` (a lone `.git` is ignored, so a freshly `git init`ed folder is fine). Symlinks and executable bits in the template are preserved.

## Set up a project (`init`)

`neon init` sets up this directory for Neon.

An empty directory (nothing except `.git`) runs `neon bootstrap .` and stops. With `-y` that is `neon bootstrap . --default`. Bootstrap handles scaffolding, agent tooling, and linking. Interactive bootstrap prints a NEON banner, asks every setup question, then runs the work — dependency install last, except when a `neon.ts` needs deps before `link`.

An existing app installs agent tooling, then `neon link` unless `.neon` already has a projectId, then `neon config init`. Interactive `config init` opens the services picker; `-y` uses `--services none` (starter policy).

In an interactive terminal it offers one of: the Neon plugin (`neon plugins`), skills and MCP separately (`neon skills`, then `neon mcp`), or skip agent setup. It never runs plugin and skills+MCP together.

```bash
$ neon init
$ neon init -y
$ neon init --agent cursor --agent claude-code
```

Without a TTY, pass `-y`. `--agent` skips agent selection but does not replace `-y` for link or templates.

`-y` skips the template picker and the agent-setup offer. Empty dir: `bootstrap --default`. Existing app: plugin when Cursor, Claude Code, or Codex is in project folders, else the host CLI agent; otherwise skills and MCP. If none are found, it exits: pass `--agent <name>`, run from a supported agent, or omit `-y` in a terminal to pick. VS Code, GitHub Copilot CLI, and Grok only take the plugin user-level (`neon plugins --global`), so `-y` uses skills and MCP for those.

`--agent` / `-a` (repeatable) names coding agents and skips agent selection, interactive or with `-y`. Init forwards those names to `plugins`, or to `skills` and `mcp`, not both.

`-y` forwards `-y` to `plugins` or `skills`/`mcp`, `--default` to `bootstrap`, `--yes` to `link`, and `--services none` to `config init`. `--agent` is forwarded with them. `mcp -y` is the global install. `link --yes` only skips the "already linked" confirmation; it still asks for a project unless one is already linked.

A failed step stops the rest. `--profile` and `--config-dir` are forwarded to each child. `--output json` and `--output yaml` are refused; the commands init runs print their own output.

`skills` needs Node.js 22.20 or newer. See [`bootstrap`](#scaffold-a-project-bootstrap), [`plugins`](#install-the-neon-plugin-plugins), [`skills`](#install-neon-agent-skills-skills), [`link`](#linking-a-project), and [`mcp`](#install-the-neon-mcp-server-mcp) for what those commands write.

## Install the Neon MCP server (`mcp`)

`neon mcp` writes the hosted Neon MCP server (`https://mcp.neon.tech/mcp`) into coding-agent config files.

```bash
# Interactive: global or project, then agents, then API key or OAuth, then confirm.
$ neon mcp

# Skip prompts. Global config, installed apps else the host CLI agent, reuse or mint an API key.
$ neon mcp -y

# OAuth: no API key minted. The agent prompts for Neon sign-in on first use.
$ neon mcp --oauth

# Named agents.
$ neon mcp --agent cursor --agent claude-code

# Project-level config. A minted key is still account-wide unless a project is pinned.
$ neon mcp --project

# Hide write tools. Does not change the minted key.
$ neon mcp --read-only

# Pin MCP tools to one project. A newly minted API key is limited to that project.
$ neon mcp --project-id <project-id>

# Limit which tool categories are visible.
$ neon mcp --category querying --category schema
```

On a TTY the command asks for config location (global is the default), then agents, then API key vs OAuth, then a summary to confirm before it writes. Detected agents start selected: globally installed agents or project-folder markers such as `.cursor` when the install is project.

`-y` skips those questions. `neon mcp -y` writes `https://mcp.neon.tech/mcp` into global config for globally installed apps, else the host CLI agent, reuses an existing Neon MCP API key or mints an account-wide key, leaves write tools enabled, exposes every tool category, and does not pin a project (including from `.neon`). `--agent`, `--project`, `--oauth`, `--read-only`, `--project-id` and `--category` still apply with `-y`. `--read-only` and `--category` are flags only and are never prompted. A linked project-folder install asks whether to pin MCP tools to that `.neon` project (`?projectId=`). If you pin and selected API-key auth, the minted key is limited to that project too. An unlinked project folder does not ask. Global installs never add that param unless you pass `--project-id`. Without a TTY, pass `-y` to mint into every detected agent, `--agent <name>` to name them, or `--oauth` to write the URL only. If `-y` finds no agent, it exits: pass `--agent <name>`, run from a supported agent, or omit `-y` in a terminal to pick. `neon mcp --help` lists the server URL, those `-y` defaults, the supported agent names, and the `--category` values.

Supported agents: `antigravity`, `cline`, `cline-cli`, `claude-code`, `codex`, `cursor`, `gemini-cli`, `goose`, `github-copilot-cli`, `grok-build`, `mcporter`, `opencode`, `vscode`, `windsurf`, `zed`. Project installs drop `antigravity`, `cline`, `cline-cli`, `goose` and `windsurf`. `claude-desktop` is a known name that is then skipped.

The default mints an account-wide API key (or reuses the Bearer already configured for Neon at `https://mcp.neon.tech/mcp`) and writes it into each selected agent's config. That key reaches everything the account can, in every organization. Revoke it with `neon api-keys revoke <id>`. `--oauth` writes the URL with no `Authorization` header; the agent signs in on first use. `--project` writes into the project config (`.cursor/mcp.json` and similar). `--read-only` adds `?readonly=true`. `--project-id` adds `?projectId=` and, when a key is minted, limits that key to the named project. Accepting the linked-project pin does the same. Revoke a project-scoped key with `neon api-keys revoke <id> --org-id <org>`. A reused Bearer keeps the scope it already has. `--category` adds `?category=` (repeatable or comma-separated: `projects`, `branches`, `schema`, `querying`, `neon_auth`, `data_api`, `observability`, `docs`). `--read-only` and `--category` restrict which MCP tools the server exposes; they do not change what the minted key can do.

## Install Neon agent skills (`skills`)

`neon skills` installs Neon agent skills by running `npx skills add`. It does not call the Neon API. This command needs Node.js 22.20 or newer. The rest of the CLI supports Node.js 20.19 or newer.

```bash
# Interactive: this directory, then agents, then skills, then confirm.
$ neon skills

# Skip prompts. This directory, detected agents (project folders, else the host CLI agent), the default skills.
$ neon skills -y

# Named skills into detected agents.
$ neon skills -y -s neon -s neon-ai-gateway

# Named skills into a named agent.
$ neon skills -s neon -s neon-ai-gateway --agent cursor

# User-level skills.
$ neon skills --global

# Update installed skills in this directory.
$ neon skills update
$ neon skills update -y
$ neon skills update --global -y
```

On a TTY the command asks which agents and which skills, then shows a summary to confirm. Detected agents start selected from project-folder markers such as `.cursor`. Default skills start selected. `neon-postgres-agent-platforms` is offered and starts unselected.

`-y` skips those questions and installs the default skills into detected agents: project-folder markers such as `.cursor`, else the agent driving the CLI. `--agent` / `-a` names coding agents and skips the agent picker. `--skill` / `-s` names specific skills and skips the skill picker; it does not select agents. `--global -y` uses installed apps, else the host CLI agent. Without a TTY, pass `-y`, or `--skill <name>` (add `--agent <name>` to name agents). If `-y` finds no agent, it exits: pass `--agent <name>`, run from a supported agent, or omit `-y` in a terminal to pick.

`--skill` names by source repo: `neondatabase/agent-skills` (`neon`, `neon-ai-gateway`, `neon-functions`, `neon-object-storage`, `neon-postgres`, `neon-postgres-branches`, `neon-postgres-egress-optimizer`); `neondatabase/neon-for-agent-platforms` (`neon-postgres-agent-platforms`).

Supported agents match `neon mcp`, minus agents that cannot install skills: `antigravity`, `cline`, `cline-cli`, `claude-code`, `claude-desktop`, `codex`, `cursor`, `gemini-cli`, `goose`, `github-copilot-cli`, `grok-build`, `opencode`, `vscode`, `windsurf`, `zed`. `mcporter` is a known MCP name that is then skipped. `neon skills --help` lists the same skill and agent values, and that `-y` leaves out `neon-postgres-agent-platforms`.

## Ask the Neon assistant (`ask`)

`neon ask --prompt` asks the hosted Neon assistant a question about Neon. It does not log in and does not use your Neon account.

```bash
neon ask --prompt "How do schema-only branches work?"
neon ask --prompt "How do schema-only branches work?" --output json
```

Default table output is the assistant's text. On a TTY that is a spinner, then the streamed reply. `--output json` and `--output yaml` print `{ "text": "…" }` after the full response.

## Install the Neon plugin (`plugins`)

`neon plugins` installs the Neon agent plugin (`neon-postgres`) by running `npx plugins add`. It does not call the Neon API.

```bash
# Interactive: agents, then confirm.
$ neon plugins

# Skip prompts. Detected agents (project folders, else the host CLI agent).
$ neon plugins -y

# Named agents.
$ neon plugins --agent cursor --agent claude-code

# User-level install.
$ neon plugins --global
```

On a TTY the command asks which agents, then shows a summary to confirm. Detected agents start selected from project-folder markers such as `.cursor`. There is one plugin (`neon-postgres`); there is no plugin picker and no `update` subcommand.

`-y` skips those questions and installs into detected agents: project-folder markers such as `.cursor`, else the agent driving the CLI. `--agent` / `-a` names coding agents and skips the agent picker. `--global -y` uses installed apps, else the host CLI agent. Without a TTY, pass `-y` or `--agent <name>`. If `-y` finds no agent, it exits: pass `--agent <name>`, run from a supported agent, or omit `-y` in a terminal to pick.

Default scope is `project`. `--global` is `user`. On macOS and Linux, Cursor and Claude Code store the plugin cache under `~/.claude/plugins`; on Windows, Cursor installs into Cursor extensions. `project` vs `user` is the scope field the plugins CLI records, not a directory in the repo. VS Code, GitHub Copilot CLI, and Grok Build only install user-level: they are skipped at the default scope with a warning, and a VS Code-only project fails if nothing else is selected. Pass `--global` for those.

Supported agents with a plugins mapping: `claude-code`, `claude-desktop`, `codex`, `cursor`, `github-copilot-cli`, `grok-build`, `vscode`. `claude-desktop` installs as Claude Code; detecting both produces one install and lists both names in the table. `mcporter` is a known MCP name that is then skipped.

The plugins CLI installs every plugin it finds in the Neon plugin package. Today that is `neon-postgres` from `neondatabase/agent-skills`. It includes the Neon MCP server (`https://mcp.neon.tech/mcp`) and these skills: `neon`, `neon-ai-gateway`, `neon-functions`, `neon-object-storage`, `neon-postgres`, `neon-postgres-branches`, `neon-postgres-egress-optimizer`. It does not include `neon-postgres-agent-platforms`.

`neon plugins --help` lists the plugin, those contents, and the supported agent names.

## Snapshots (`snapshots`)

`neon snapshots` (alias `neon snapshot`) manages **snapshots** — point-in-time backups of a branch that you can list, rename, expire, restore into a branch, or schedule automatically. Snapshots are a Beta Neon feature and were previously only available in the Console and REST API; this command group brings them to the CLI.

Every sub-command resolves the project through the standard chain (`--project-id`, then the `.neon` context file, then a single-project auto-detect). Branch-scoped sub-commands (`create`, `schedule`) default to the branch pinned in `.neon`, falling back to the project's default branch, and accept `--branch <id|name>`. The `get`, `update`, `delete`, and `restore` sub-commands take a snapshot **id or name** as their positional argument (an id wins; an ambiguous name errors and asks you to use the id).

```bash
# Snapshot the head of the current/default branch
neon snapshots create --name pre-migration

# Snapshot a specific branch at a point in time (RFC 3339 timestamp OR LSN — mutually exclusive)
neon snapshots create --branch main --timestamp 2025-01-01T00:00:00Z
neon snapshots create --branch main --lsn 0/1F3C8A0 --expires-at 2025-12-31T23:59:59Z

# List / inspect
neon snapshots list
neon snapshots get pre-migration

# Rename or change expiration (omit both to error; --expires-at and --clear-expiration conflict)
neon snapshots update snap-1234 --name nightly
neon snapshots update snap-1234 --expires-at 2030-01-01T00:00:00Z
neon snapshots update snap-1234 --clear-expiration      # keep indefinitely

# Restore a snapshot to a NEW branch
neon snapshots restore snap-1234 --name recovered

# Restore ONTO an existing branch. Without --finalize the restore is left un-finalized
# so you can inspect it first, then swap it in:
neon snapshots restore snap-1234 --target-branch main
neon snapshots finalize br-restored-1234                # commit the swap
# …or do it in one step:
neon snapshots restore snap-1234 --target-branch main --finalize

# Delete
neon snapshots delete snap-1234

# Automatic snapshot (backup) schedule of a branch
neon snapshots schedule get --branch main
neon snapshots schedule set --branch main --frequency daily --hour 3 --retention 604800
neon snapshots schedule set --branch main --schedule '[{"frequency":"weekly","day":1,"hour":2},{"frequency":"daily","hour":3}]'
```

All sub-commands honor the [global options](#global-options), including `--output json|yaml|table`.

## Database diagnostics (`inspect`)

`neon inspect db stalled-queries` takes a read-only snapshot of active queries that have run for more than 30 seconds and groups parallel workers with their leader. Oldest group first. Table output shows duration, wait event, blocking pids, role, query group, and query. `--output json` adds timestamps, query IDs, pids, database, and the rest of the row. A blocking pid can belong to an idle-in-transaction backend this command does not list; `neon inspect db locks` shows lock holders.

```bash
neon inspect db stalled-queries
neon inspect db stalled-queries --output json
```

## Logs (`logs`)

`neon logs` reads the log records the services on a branch emit — Neon Functions, object storage, and Postgres computes. **Logs require Neon Platform Beta and are currently available only for projects in `aws-us-east-2`.**

Every sub-command resolves the project through the standard chain (`--project-id`, then the `.neon` context file, then a single-project auto-detect), and takes `--branch <id|name>`, defaulting to the project's default branch. `logs query` searches the previous hour by default; `logs field-values` searches the previous six hours. The maximum time window is seven days.

```bash
# The last 30 minutes on the default branch
neon logs query --since 30m

# Postgres compute errors on main, oldest first
neon logs query --branch main --source pg_endpoint --minimum-severity error --sort-order asc

# An explicit window (--start-time replaces --since; --end-time works with either)
neon logs query --start-time 2025-01-01T00:00:00Z --end-time 2025-01-01T01:00:00Z

# One request trace, across every service that took part in it
neon logs query --trace-id 4bf92f3577b34da6a3ce929d0e0e4736

# What the structured filters cannot express: a raw LogQL selection. It replaces
# them, but the window, --limit, --sort-order and --cursor still apply.
neon logs query --since 1h --logql '{entity_type="function"} |= "timeout"'

# Which fields this branch supports, and the values it has actually seen
neon logs fields
neon logs field-values service_name --since 6h --source function
```

A response holds at most `--limit` records (1–1000; default 100). When more matched, table output prints the `--cursor` to repeat the same query with; `--output json|yaml` returns `is_truncated` and `next_cursor` on the envelope instead, so nothing but the payload lands on stdout. Table output shows the common fields; use structured output for the complete records:

```console
$ neon logs query --since 24h --output json
{
  "logs": [
    {
      "timestamp": "2025-01-01T00:00:02.000Z",
      "message": "GET /api/todos 200",
      "source": "function",
      "service_name": "api",
      "severity_text": "INFO",
      "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
      "attributes": { "http_status": 200 }
    }
  ],
  "next_cursor": "eyJvZmZzZXQiOjEwMH0",
  "is_truncated": true
}
```

Two combinations are rejected before the request: `--since` with `--start-time`, and `--logql` with any of `--source`, `--service-name`, `--scope-name`, `--minimum-severity`, `--severity-text`, `--body-contains` or `--trace-id`. `--minimum-severity` and `--severity-text` are independent filters and combine with AND. If Neon reports that `--minimum-severity` is unsupported, use `--severity-text` instead; `neon logs field-values severity_text` lists the exact values present on a branch.

`--body-contains` compares a case-sensitive substring against the rendered message. Structured bodies, including object storage records, are rendered as compact JSON, so match the JSON form (for example, `"http_status":200`).

## Profiles

The CLI holds one Neon account by default. A profile adds another, and is a pointer: a
credentials file path, or the sentinel `"keyring"` when the secret is in the OS keyring.

```
~/.config/neon/
├── credentials.json          # this IS the DEFAULT profile
├── credentials.work.json     # created by `neon profile create work`
└── profiles.json             # created once a second profile exists, or DEFAULT is keyring
```

```bash
neon profile create work              # a browser sign-in, or an API key — see below
neon profile create work --keyring    # same, stored in the OS keyring
neon profile list
neon profile remove work
```

```console
$ neon profile list
Profiles
Active  Name     Account         Auth     Credentials          Scope
*       DEFAULT  me@example.com  oauth    credentials.json     account
        work     me@example.com  api key  keyring              account
        ci       org-abc-123     api key  credentials.ci.json  project proj-1
```

`Scope` is what the credential can reach. An OAuth session and an unscoped user API key both
show `account`. A project or org key names that project or org. `Credentials` is the path
relative to the config directory, or `keyring`. A path outside the config directory is shown
absolute. `--output json` keeps the absolute path, and also includes `file` (`ok`, `invalid`,
`missing`, or `unreadable`) and `storage` (`file` or `keyring`). A keyring get of null is
`unreadable`, not missing: the addon cannot tell those apart.

Select one per invocation with `--profile`, or per shell with `NEON_PROFILE`. There is no `profile use` command and nothing is stored about which profile is "current", so what you type is always what runs.

Entries in `profiles.json` are pointers — a path, or the exact string `"keyring"` — and a path may point anywhere, which is how you adopt a directory you already have without moving or re-authenticating anything:

```json
{
  "version": 1,
  "profiles": {
    "DEFAULT": { "credentials": "keyring" },
    "work": { "credentials": "../neonctl-work/credentials.json" }
  }
}
```

An unreadable `profiles.json` fails every command that needs a profile, including a
file-only DEFAULT. That file is the only record of where each account's credentials live,
so the CLI will not guess past it. Fix or delete it.

`neon profile remove` revokes what the profile holds — an OAuth refresh token at the
authorization server, or an API key this CLI minted — rather than only forgetting it locally. A
key you supplied is the exception and stays live, because nothing records its id; the command
says so. It asks for confirmation first, which `--yes` skips; without a terminal on stdin, in
CI or behind a pipe, it refuses rather than prompting into the void. It deletes the credentials
file only when the CLI created it: an adopted path like the one above is unlinked and left on
disk, and the command says so. A keyring profile's OS item is deleted when the store confirms
it is gone. If it cannot, remove still resets the profile and warns that a leftover may remain
in the OS store; it is unused once the profile is gone. Removing the last named profile
deletes `profiles.json` unless DEFAULT itself is keyring — that entry is the only record that
the secret is not in `credentials.json`. `neon profile remove DEFAULT` signs you out.

### Where the secret is stored

The default is a credentials file. A profile uses the OS keyring (macOS Keychain, Windows
Credential Manager, Linux Secret Service) only when its `profiles.json` pointer is `"keyring"`.
That is per profile. Reads never migrate.

```bash
neon auth --keyring                         # sign DEFAULT into the OS keyring
neon auth --keyring --profile work          # sign work into the OS keyring
neon profile create work --keyring          # create a named profile in the keyring
neon profile remove work --yes              # drop a keyring profile, then create it again as a file
```

File to keyring is `neon auth --keyring` or `neon profile create … --keyring`: a new
sign-in, then the previous credential is revoked and the owned file is deleted.
`create` on an existing name always revokes after a successful write. `auth` revokes
when it writes to the keyring, including a re-login that follows an existing pointer.
`auth` that overwrites a file does not. Keyring to file is `remove`, then create or
auth again. `create` and `auth` without `--keyring` follow an existing `"keyring"`
pointer, so a keyring profile cannot leave the OS store until `remove` succeeds.

`--api-key` and `NEON_API_KEY` skip both stores. A GitHub-release `neon-<platform>`
binary recognizes a `"keyring"` pointer and refuses: it cannot load the OS keyring addon.
Use the npm-installed `neon`. Older releases treat the sentinel as a relative path.

A `"keyring"` pointer whose OS item cannot be read is not treated as signed-out. Commands that
would otherwise open a browser fail: could not read the OS keyring item. Unlock it and
retry, or run `neon auth --profile DEFAULT`. To reset the profile: `neon profile remove DEFAULT --yes`.
A missing `credentials.json` with no `profiles.json` is still
signed-out, and those commands start OAuth.

### A profile holds either a sign-in or an API key

`neon profile create` makes a profile, and how you call it decides which kind of credential it holds. A key-backed profile is what you want for an agent, a shared machine, or anything that must never be interrupted by a browser:

```bash
neon profile create work                            # sign in; replaces work if it already exists
neon profile create work --keyring                  # same, stored in the OS keyring
neon profile create work --api-key "$KEY"           # store a key you already have
echo "$KEY" | neon profile create work --api-key -  # or pipe it, keeping it out of argv
neon profile create ci --mint                       # sign in once, keep only a minted key
neon profile create ci --mint --org-id org-abc-123  # minted for an organization
neon profile create ci --mint --project-id proj-1   # minted for one project only
neon profile rotate-key work                        # mint a replacement, revoke the old one
```

Replacing a profile revokes the credential it held, so a key this CLI minted stops working
everywhere it was pasted, and an OAuth session is signed out. To keep a working profile and
swap only its key, use `rotate-key`.

`create` and `rotate-key` print the profile they wrote, so an agent needn't follow up with
`list`. Under `--output json` that is a record, and it never carries the secret:

```console
$ neon profile create ci --mint --org-id org-abc-123 --output json
{"name":"ci","account":"org-abc-123","auth":"api key","scope":"org org-abc-123","keyId":3239771,"credentials":"/home/me/.config/neon/credentials.ci.json"}
```

One flag takes the key, because the shell already covers the variations: `--api-key "$(cat
~/keys/work)"` reads a file and `--api-key "$KEY"` takes a variable. Those put the key in the
process arguments, where `ps` and shell history can see it, so `--api-key -` reads it from stdin
instead — the usual convention for a piped value. `--mint` avoids the question entirely, because
the key never leaves the CLI.

**A profile is one kind or the other, never both.** `type` in the credentials file states which:

```json
// oauth: what a plain `create` (or `neon auth --profile`) writes. An absent `type` means this.
{ "access_token": "…", "refresh_token": "…", "expires_at": 1786…, "user_id": "…" }

// api_key: what `--api-key` writes
{ "type": "api_key", "api_key": "napi_…", "user_id": "…" }

// api_key from `--mint --org-id`, which records the scope it was issued at
{ "type": "api_key", "api_key": "napi_…", "key_id": 123, "org_id": "org-…" }
```

Nothing is carried over when a profile is replaced, so one profile can never hold two credentials — or two different accounts. The secret stays in the credentials file or the OS keyring and never goes into `profiles.json`, so listing profiles cannot leak one. Files are written owner-only through a temporary file and a rename, which also repairs the permissions of a file created too permissively.

`--mint` is the one to reach for. It signs you in through the browser once, mints a key with that session, stores only the key, and signs the session back out — so afterwards nothing about the profile can open a browser, and no half-forgotten login is left behind. `--org-id` and `--project-id` narrow what the minted key can reach, exactly as they do on [`neon api-keys create`](#api-keys); a project-scoped key cannot create projects, mint keys, or read any other project.

Every key is verified against the API before it is stored, and the account it belongs to is recorded so `profile list` can show it. Only a real API key is accepted: an OAuth access token authenticates today and then expires with nothing to refresh it.

`rotate-key` mints at the scope the profile already has — replacing an org key with an account key would quietly widen everything it reaches — and stores the new key before revoking the old one, so a failed write leaves the old key working.

One thing it cannot do: **an organization key cannot mint its own replacement.** Neon only accepts a personal credential when creating organization keys, so rotating an org- or project-scoped profile means signing in again — `neon profile create ci --mint --org-id org-abc-123`. `rotate-key` checks this before minting and says so, rather than letting the API answer with a rule you had no reason to expect.

Two things the CLI cannot do for a key you supplied rather than minted. It cannot revoke it, because `GET /api_keys` exposes no prefix and a stored secret cannot be matched to a listing entry, so both `rotate-key` and `profile remove` say the old key is still live and point you at `neon api-keys list`. For a key you supplied it records the organization the API reports, but cannot know whether that key was narrowed to a single project — so `rotate-key` will not suggest an organization-wide replacement without telling you to check `neon api-keys list` first.

If a stored key stops working there is nothing to refresh, so recovery is one browser sign-in: `neon profile create work --mint`.

### Which credential an invocation uses

An explicit flag always beats an environment variable:

| Given | What runs |
| --- | --- |
| `--api-key` and `--profile` | neither — contradictory, so the command fails |
| `--api-key` and `NEON_PROFILE` | the flag's key |
| `--profile` and `NEON_API_KEY` | the profile |
| `NEON_API_KEY` and `NEON_PROFILE` | the key, and the ignored profile is named in a warning |
| `--profile` or `NEON_PROFILE` alone | that profile |
| nothing | `DEFAULT` |

Passing both flags fails rather than picking a winner: `--api-key` supplies a credential and `--profile` selects a stored one, so there is no reading of the command that makes both true.

When both are only environment variables the key wins, which keeps a CI pipeline that injects `NEON_API_KEY` working even if a `NEON_PROFILE` leaks into the environment — but the disregarded profile is named on stderr rather than passed over silently.

`neon auth` and the `profile` subcommands are outside all of this, because they read the same flags to mean something else: `neon auth --profile work` names where to write a credential, and `neon profile create work --api-key …` names one to store.

`neon init` forwards `--profile` and `--config-dir` to the commands it runs. An explicit `--api-key` is passed to those children through `NEON_API_KEY`, not argv.

## API passthrough (`api`)

`neon api` sends an authenticated request to any Neon API route. `neon api --list` catalogs the routes. `neon api <path> --describe` prints the OpenAPI request shape for one operation so you can fill `-F` and `-Q` without guessing. Body field names are dotted to match `-F`.

```bash
neon api --list
neon api /projects --describe
neon api /projects -X POST --describe -o json
neon api /projects/{project_id}/branches -X POST --describe
neon api /projects/foo-bar-123/branches -X POST -F branch.name=dev
```

`--describe` does not send the selected API request. It uses the same CLI authentication as `--list`. `-X` defaults to GET; if that method is missing, the error names the methods that exist.

## API keys (`api-keys`)

```bash
neon api-keys list                                        # your account's keys
neon api-keys list --org-id org-…                         # an organization's, with scope shown

neon api-keys create --name ci                            # account key
neon api-keys create --name ci    --org-id org-…          # organization key
neon api-keys create --name agent --project-id frosty-…   # can access only that project

neon api-keys revoke <id> [--org-id org-…]
```

The key is returned once, on create, and cannot be retrieved again. It prints on its own line below the metadata, so it can be selected in one gesture regardless of terminal width — and `… | tail -1` on stdout yields exactly the key, since both notices go to stderr.

```console
$ neon api-keys create --name agent --project-id proj-in-org
API key
Id       303
Name     agent
Project  proj-in-org

napi_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
WARNING: Store this key now: it is not shown again.
INFO: Limited to proj-in-org: it cannot create projects, mint API keys, or read any other project. It can still change and delete everything inside that project.
```

`--org-id` and `--project-id` are mutually exclusive. A project-scoped key *is* an organization key, and its organization is looked up from the project rather than chosen separately. With neither flag you get an account key.

### Project-scoped keys

A key created with `--project-id` bounds what it can reach to one project. Verified against a real scoped key:

| Attempt | Result |
| --- | --- |
| Read and write its own project | works |
| Read any other project | `project not found` — not even an existence oracle |
| `neon projects create` | `project-scoped keys are not allowed to create projects` |
| `neon projects list` | refused |
| `neon api-keys create` / `list` | refused (true of any organization key, not only scoped ones) |
| `neon orgs list` | **works** — it can see the id, name and handle of the organization it belongs to |
| Anything else about that organization (`GET /organizations/{id}`, members) | refused |

It is **not** read-only. Inside its one project it can do everything the API allows, including deleting branches and the project itself — `neon deploy` working at all is proof of that. What it bounds is *reach*, which is what lets you hand it to an agent or a CI job without handing over your account:

```bash
neon link --project-id frosty-…       # once, as yourself — writes .neon
NEON_API_KEY=napi_… neon deploy       # then the agent, reaching only that project
```

`neon link` needs `--project-id` explicitly when using a scoped key: the interactive picker lists your projects, which a scoped key cannot do.

`api-keys` deliberately ignores the `.neon` context file, unlike every other project command. Otherwise `neon api-keys create --name ci` inside a linked directory would silently mint a key scoped to that project instead of the account key you asked for. How far a credential reaches comes only from a flag you typed.

### Seeing what is scoped

```console
$ neon api-keys list --org-id org-7
API keys in org-7
Id   Name      Project         Created At            Last Used At          Last Used From Addr
301  scoped    proj-in-org     2026-01-02T00:00:00Z
302  org-wide  (all projects)  2026-01-03T00:00:00Z  2026-02-03T00:00:00Z  203.0.113.9
```

`last_used_at` and `last_used_from_addr` are how you spot a key worth revoking.

## Commands

| Command                                                                    | Subcommands                                                                                                  | Description                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| [auth](https://neon.com/docs/reference/cli-auth)                           |                                                                                                              | Authenticate                       |
| claim (`claimable`)                                                        | `create`, `status`, `accept`, `list`, `delete`                                                               | Manage claimable projects          |
| profile                                                                    | `list`, `create`, `rotate-key`, `remove`                                                                     | Manage named sets of credentials   |
| api-keys                                                                   | `list`, `create`, `revoke`                                                                                   | Manage API keys                    |
| api                                                                        |                                                                                                              | Call any Neon API route            |
| [projects](https://neon.com/docs/reference/cli-projects)                   | `list`, `create`, `update`, `delete`, `get`                                                                  | Manage projects                    |
| [ip-allow](https://neon.com/docs/reference/cli-ip-allow)                   | `list`, `add`, `remove`, `reset`                                                                             | Manage IP Allow                    |
| [me](https://neon.com/docs/reference/cli-me)                               |                                                                                                              | Show current user                  |
| [branches](https://neon.com/docs/reference/cli-branches)                   | `list`, `create`, `rename`, `add-compute`, `set-default`, `set-expiration`, `delete`, `get`                  | Manage branches                    |
| [databases](https://neon.com/docs/reference/cli-databases)                 | `list`, `create`, `delete`                                                                                   | Manage databases                   |
| function                                                                   | `deploy`, `list`, `get`, `delete`                                                                            | Manage Neon Functions              |
| [roles](https://neon.com/docs/reference/cli-roles)                         | `list`, `create`, `delete`                                                                                   | Manage roles                       |
| [operations](https://neon.com/docs/reference/cli-operations)               | `list`                                                                                                       | Manage operations                  |
| logs                                                                       | `query`, `fields`, `field-values`                                                                            | Query branch logs (Beta)           |
| inspect                                                                    | `db stalled-queries`                                                                                         | Inspect Postgres diagnostics       |
| snapshots                                                                  | `list`, `get`, `create`, `update`, `delete`, `restore`, `finalize`, `schedule get`, `schedule set`           | Manage snapshots                   |
| [connection-string](https://neon.com/docs/reference/cli-connection-string) |                                                                                                              | Get connection string              |
| [psql](https://neon.com/docs/reference/cli-psql)                           |                                                                                                              | Connect to a database via psql     |
| set-context                                                                |                                                                                                              | Deprecated; use `link`             |
| env                                                                        | `pull`                                                                                                       | Manage a branch's env vars         |
| checkout                                                                   |                                                                                                              | Pin a branch in `.neon`            |
| diff                                                                       |                                                                                                              | Git-style schema diff vs a branch  |
| [link](https://neon.com/docs/reference/cli-link)                           |                                                                                                              | Link a directory to a project      |
| open                                                                       |                                                                                                              | Open the linked project in Console |
| config                                                                     | `init`, `status`, `plan`, `apply`                                                                            | Drive a branch from `neon.ts`      |
| deploy                                                                     |                                                                                                              | Alias for `config apply`           |
| bootstrap                                                                  |                                                                                                              | Scaffold a template, then agent tooling and link |
| init                                                                       |                                                                                                              | Empty dir: bootstrap. Existing: agents, link, neon.ts |
| mcp                                                                        |                                                                                                              | Install the Neon MCP server         |
| plugins                                                                    |                                                                                                              | Install the Neon plugin             |
| skills                                                                     | `update`                                                                                                     | Install Neon agent skills           |
| ask                                                                        |                                                                                                              | Ask a question about Neon          |
| bucket                                                                     | `create`, `list`, `delete`, `object list`, `object get`, `object put`, `object delete` (incl. `--recursive`) | Manage buckets and their objects   |
| [completion](https://neon.com/docs/reference/cli-completion)               |                                                                                                              | Generate a completion script       |

## Global options

Global options are supported with any Neon CLI command.

| Option                      | Description                                                 | Type    | Default                        |
| :-------------------------- | :---------------------------------------------------------- | :------ | :----------------------------- |
| [-o, --output](#output)     | Set the Neon CLI output format (`json`, `yaml`, or `table`) | string  | table                          |
| [--config-dir](#config-dir) | Path to the Neon CLI configuration directory                | string  | `/home/<user>/.config/neon`    |
| [--profile](#profile)       | Named credentials to use, from `profiles.json`              | string  | `DEFAULT`                      |
| [--api-key](#api-key)       | Neon API key                                                | string  | ""                             |
| [--analytics](#analytics)   | Manage analytics                                            | boolean | true                           |
| [-v, --version](#version)   | Show the Neon CLI version number                            | boolean | -                              |
| [-h, --help](#help)         | Show the Neon CLI help                                      | boolean | -                              |

- <a id="output"></a>`-o, --output`

  Sets the output format. Supported options are `json`, `yaml`, and `table`. The default is `table`. Table output may be limited. The `json` and `yaml` output formats show all data.

  ```bash
  neon me --output json
  ```

- <a id="config-dir"></a>`--config-dir`

  Specifies the path to the `neon` configuration directory, which holds the `credentials.json` written by `neon auth` and, when a second profile exists or DEFAULT is keyring, `profiles.json`. The default is `$XDG_CONFIG_HOME/neon`, or `~/.config/neon`; run `neon --help` to see the resolved path. This option is only necessary if you keep your configuration somewhere else.

  The directory was called `neonctl` before the CLI was renamed. An existing one is still read, and is used **in place** — nothing is moved or copied, so there is never a second credentials file to go stale. A directory you pass explicitly is used exactly as given and never falls back to the legacy name, so pointing a CI run at a scratch directory cannot pick up local credentials.

  ```bash
  neon projects list --config-dir /home/dtprice/.config/neon
  ```

- <a id="profile"></a>`--profile`

  Selects a named set of credentials, for holding more than one Neon account at a time. A profile is a pointer to a credentials file, recorded in `profiles.json` next to it.

  ```bash
  neon auth --profile work        # create it, or sign in again
  neon profile list               # names, accounts, and where each one's credentials live
  neon projects list --profile work
  NEON_PROFILE=work neon projects list
  ```

  Precedence is `--profile`, then `NEON_PROFILE`, then `DEFAULT`. `DEFAULT` is plain `credentials.json`, so an install with a single account needs no `profiles.json` and behaves exactly as before. See [Profiles](#profiles) to list or remove them.

- <a id="api-key"></a>`--api-key`

  Specifies your Neon API key. You can authenticate using a Neon API key when running a Neon CLI command instead of using `neon auth`. For information about obtaining an Neon API key, see [Authentication](https://neon.com/docs/reference/api/get-started), in the _Neon API Reference_.

  ```bash
  neon <command> --api-key <neon_api_key>
  ```

- <a id="analytics"></a>`--analytics`

  Analytics are enabled by default to gather information about the CLI commands and options that are used by our customers. This data collection assists in offering support, and allows for a better understanding of typical usage patterns so that we can improve user experience. Neon does not collect user-defined data, such as project IDs or command payloads, except the question passed to `neon ask --prompt`. To opt-out of analytics data collection, specify `--no-analytics` or `--analytics false`.

- <a id="version"></a>`-v, --version`

  Shows the Neon CLI version number.

  ```bash
  $ neon --version
  1.15.0
  ```

- <a id="help"></a>`-h, --help`

  Shows the `neon` command-line help. You can view help for `neon`, a `neon` command, or a `neon` subcommand, as shown in the following examples:

  ```bash
  neon --help

  neon branches --help

  neon branches create --help
  ```

## Contribute

This repo uses [pnpm](https://pnpm.io). The required version is pinned in `.tool-versions` and `package.json`'s `packageManager` field. The simplest way to get the right version is [mise](https://mise.jdx.dev): `mise install` reads `.tool-versions` and installs Node and pnpm. Alternatives: `npm install -g pnpm@9.15.9`, or [Corepack](https://nodejs.org/api/corepack.html) (`corepack enable pnpm`).

To run the CLI locally, execute the build command after making changes:

```shell
pnpm install
pnpm run build
```

To develop continuously:

```shell
pnpm run watch
```

To run commands from the local build, replace the `neon` command with `node dist`; for example:

```shell
node dist branches --help
```

### Embedded psql tests

The embedded TypeScript psql implementation has its own conformance test suite that runs the same scripts against the embedded psql and a reference `psql` binary, then diffs the output.

```shell
bun run test:conformance         # run against $PSQL_BINARY (defaults to the system psql)
bun run test:conformance:matrix  # run across PG 14/15/16/17/18 locally (requires Docker)
```

## Releasing

Maintainers: see the repository's [release skill](../../.claude/skills/release/SKILL.md)
for the Changesets bump and external publish flow.
