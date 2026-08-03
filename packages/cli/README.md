# Neon CLI

The `neon` package is a command-line interface that lets you manage [Neon](https://neon.tech/) — Lakebase Postgres, Object Storage, Functions, Managed Better Auth, and the AI Gateway — directly from the terminal. For the complete documentation, see [Neon CLI](https://neon.tech/docs/reference/neon-cli).

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

The `auth` command launches a browser window where you can authorize the Neon CLI to access your Neon account. Running a Neon CLI command without authenticating with [neon auth](https://neon.tech/docs/reference/cli-auth) automatically launches the browser authentication process.

Alternatively, you can authenticate a connection with a Neon API key using the `--api-key` option when running a Neon CLI command. For example, an API key is used with the following `neon projects list` command:

```bash
neon projects list --api-key <neon_api_key>
```

For information about obtaining an Neon API key, see [Authentication](https://api-docs.neon.tech/reference/authentication), in the _Neon API Reference_.

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

`neon psql [branch]` opens a psql session against a branch. It builds the connection string for the branch and launches psql — a shortcut for `neon connection-string --psql`. See [Neon CLI commands — psql](https://neon.com/docs/reference/cli-psql) for the full reference.

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

The Neon CLI supports autocompletion, which you can configure in a few easy steps. See [Neon CLI commands — completion](https://neon.tech/docs/reference/cli-completion) for instructions.

## Linking a project

`neon link` is a Vercel-style command that binds the current directory to a Neon project. It picks (or creates) an organization and a project and writes a `.neon` file (`{ "orgId", "projectId", "branch" }`) that subsequent commands run in this directory (or any sub-directory) pick up automatically.

`link` resolves what it can and **verifies every identifier you pass** before writing, so a `.neon` is never left half-written or pointing at something that doesn't exist:

- **org** is inferred from the project (so `--project-id` alone is enough); it's omitted only when the project has no organization (personal account).
- **project** is taken from `--project-id` (or chosen interactively / via `--agent`).
- **branch** is left to an explicit [`neon checkout <branch>`](#checkout) — `link` never silently pins a project's default branch (that would make later commands quietly target, say, production). It only records a branch when you pass `--branch`, when one is already pinned for the same project (preserved), when you pick one in the interactive picker, or for a freshly **created** project (whose single branch is unambiguous).

When a branch ends up pinned, `link` also runs [`env pull`](#env-pull) so the branch's Neon env vars (`DATABASE_URL`, …) land in a local `.env`. With no branch pinned there is nothing to pull, so `link` instead nudges you to run `neon checkout`. Pass `--no-env-pull` to skip the pull (for example when injecting env at runtime with `neon-env run` or `neon dev`).

> **Migrating from `set-context`?** `set-context` is **deprecated** in favor of `link` (see [below](#set-context-is-deprecated)). It still works exactly as before for now (a raw write), it just prints a deprecation warning. The `.neon` `branchId` field is also superseded by `branch` (which stores the branch **name** when known); old `branchId` files are still read and are upgraded to `branch` the next time `link`/`checkout` writes the context.

There are three modes:

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
`neon checkout` (a single-branch project is pinned automatically, no prompt). Non-interactive
`link --project-id …` does **not** prompt or default a branch; it links org + project and leaves
branch selection to `neon checkout`:

```bash
? Which organization would you like to link? › Personal Org (org-abc123)
? Which project would you like to link? › my-app (polished-snowflake-12345678)
? Which branch would you like to link? › [default] main (br-main-branch-87654321)
```

**Non-interactive (flags or `--params` JSON)** — for scripts and CI:

```bash
# Link to an existing project (org is inferred from the project; no branch pinned)
neon link --project-id polished-snowflake-12345678

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

**Agent mode (`--agent`)** — a JSON state machine designed for AI coding assistants. Each invocation returns a single JSON object with a `status` discriminator describing the next step, the available options, and the exact follow-up command to run.

```bash
$ neon link --agent
{
  "status": "needs_org",
  "instruction": "Ask the user which of these 2 organizations they want to link the current directory to. After they pick one, re-run the next_command_template with the chosen --org-id value.",
  "options": [
    { "id": "org-abc123", "name": "Personal Org" },
    { "id": "org-team",   "name": "Team Org" }
  ],
  "next_command_template": "neon link --agent --org-id <org_id>"
}

$ neon link --agent --org-id org-abc123
{
  "status": "needs_project",
  "instruction": "Ask the user whether to link to one of these 1 existing projects (use next_command_template with --project-id) or create a new project (use create_option.next_command_template).",
  "options": [
    { "id": "polished-snowflake-12345678", "name": "my-app" }
  ],
  "create_option": {
    "instruction": "To create a new project, ask the user for a project name. The region can be omitted to receive a follow-up needs_project_details response that lists available regions.",
    "next_command_template": "neon link --agent --org-id org-abc123 --project-name <name> --region-id <region_id>"
  },
  "next_command_template": "neon link --agent --org-id org-abc123 --project-id <project_id>"
}

$ neon link --agent --org-id org-abc123 --project-id polished-snowflake-12345678
{
  "status": "linked",
  "context_file": "/path/to/cwd/.neon",
  "context": {
    "orgId": "org-abc123",
    "projectId": "polished-snowflake-12345678"
  },
  "project": { "id": "polished-snowflake-12345678" },
  "message": "Linked /path/to/cwd/.neon to project polished-snowflake-12345678 (org org-abc123). No branch pinned — run `neon checkout <branch>` (omit the branch to list options) to pin one and pull its env vars."
}
```

The `linked` response omits `branch` unless one was pinned (via `--branch`, an existing pin, or project creation); pass `--branch <name|id>` to include it. The agent flow also handles project creation: if the agent sends `--project-name` without `--region-id`, the next response is `needs_project_details` with the list of supported regions.

**Organization-scoped API keys** (those created at the organization level rather than the user level) cannot list user organizations or call the regions endpoint. `link` handles this transparently:

- If the API key is org-scoped and at least one project already exists in the org, the CLI auto-detects the `org_id` from the first project. In interactive mode it prints an informational message; in `--agent` mode it skips straight to `needs_project`.
- If the API key is org-scoped and no projects exist yet, `--agent` returns a `needs_org` response with `options: []` and an instruction telling the user to find their org ID in the Neon Console. Interactive mode prints an error pointing to `--org-id`.
- When the regions endpoint is not allowed, `link` falls back to a built-in static region list.

**Agent error contract**: any unexpected failure in `--agent` mode is reported as JSON to stdout with exit code 1, so agents can always parse the response:

```json
{
  "status": "error",
  "code": "CLIENT_ERROR",
  "message": "user has no access to projects"
}
```

**Offline writes (`--no-checks`)** — write the `.neon` with no API calls at all: no org inference, no existence/access verification, no env pull. Because nothing can be resolved offline, it requires both `--org-id` and `--project-id` (`--branch` optional, stored verbatim). Handy for scripted/CI setups or re-creating a `.neon` from values you already trust:

```bash
neon link --no-checks --org-id org-abc123 --project-id polished-snowflake-12345678 --branch main
```

#### `set-context` is deprecated

`set-context` is **deprecated** in favor of `link` and prints a deprecation warning (to stderr, so it never pollutes stdout or scripts). For backward compatibility its behavior is **unchanged**: it's still a raw, offline write of exactly the fields you pass (no org inference, no verification, no env pull), and bare `set-context` still clears the file. Nothing breaks today — but new work should use `link`, and `set-context` will be removed in a future major release.

How today's `set-context` uses map onto `link`:

| `set-context` (deprecated)              | Recommended `link` equivalent                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `neon set-context --project-id <id>` | `neon link --project-id <id>` (infers org + verifies; branch via checkout) |
| `neon set-context --org-id <id>`     | `neon link --org-id <id>`                                                  |
| `neon set-context --branch-id <id>`  | `neon link --branch <name\|id>`                                            |
| `neon set-context` (clear)           | `neon link --clear`                                                        |
| a raw local write (no network)          | `neon link --no-checks --org-id <id> --project-id <id>`                    |

The key difference: `link` resolves and **verifies** before writing (so you never get a half-written or stale `.neon`), whereas `set-context` writes whatever you give it verbatim. The closest like-for-like replacement for the old raw write is `link --no-checks`.

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

`env pull` writes the linked branch's Neon environment variables into a local dotenv file: an existing `.env` if you have one, otherwise `.env.local` (override with `--file <path>`). Only Neon-managed keys (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and the Neon Auth / Data API URLs when those services are enabled) are written; any other lines in the file are preserved. The branch comes from the closest `.neon` file, so no `--branch` is needed (pass `--branch <id|name>` to target another branch).

`link` and `checkout` invoke `env pull` automatically (see above), so you usually only run it by hand to refresh vars or to pull a different branch into a specific file:

```bash
# Refresh the linked branch's vars in place
neon env pull

# Pull a specific branch into a specific file
neon env pull --branch preview --file .env.preview
```

If you'd rather not keep env vars on disk, inject them at runtime instead with `neon-env run -- <your dev command>` (from `@neon/env`) or `neon dev`, and pass `--no-env-pull` to `link` / `checkout`.

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
neon config init --services auth,functions,storage,ai-gateway

# Explicitly ask for the bare starter policy
neon config init --services none

# Scaffold but print the install command instead of running it
neon config init --no-install
```

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

Function deploys declared under `preview.functions` are bundled by neon's own esbuild helper and uploaded as part of `apply`, so the policy stays declarative and the packaged CLI never has to embed esbuild's native binary.

When a package cannot be bundled — a native addon with no esbuild loader, or an optional peer dependency a library references on an untaken code path — list it in that function's `externalPackages` and the bundler leaves the import alone. `neon dev` honours the same list. It does not make the package resolvable in the deployed archive (there is no `node_modules` next to the bundle), so it only unblocks an import that is never evaluated — a dependency the handler actually calls has to be bundled, and a natively-backed one cannot be. See [`@neon/config`](../config/README.md#unbundleable-dependencies-externalpackages).

## Scaffold a project (`bootstrap`)

`neon bootstrap` copies a Neon starter template into a new (or current) directory — conceptually like `degit`, but it only pulls from a small set of templates we maintain in the public [`neondatabase/examples`](https://github.com/neondatabase/examples) repo. It requires no Neon login: it just downloads files from GitHub.

Pass a target directory (or `.` for the current one). In an interactive terminal you pick the template from a list; in CI / non-interactive contexts pass `--template <id>`.

```bash
# Pick a template interactively and scaffold it into ./my-app
$ neon bootstrap my-app

# Scaffold a specific template into the current directory (no prompts)
$ neon bootstrap . --template hono
```

The target directory must be empty unless you pass `--force` (a lone `.git` is ignored, so a freshly `git init`ed folder is fine). Symlinks and executable bits in the template are preserved.

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

## Profiles

The CLI holds one Neon account by default. A profile adds another, and is nothing more than a pointer to a credentials file:

```
~/.config/neon/
├── credentials.json          # this IS the DEFAULT profile
├── credentials.work.json     # created by `neon auth --profile work`
└── profiles.json             # created only once a second profile exists
```

```bash
neon auth --profile work     # create it, or sign in again
neon profiles list
neon profiles remove work
```

```console
$ neon profiles list
Profiles
┌────────┬─────────┬─────────────────────┬─────────┬───────────┬──────────────────────────────────────┐
│ Active │ Name    │ Account             │ Auth    │ Available │ Credentials                          │
├────────┼─────────┼─────────────────────┼─────────┼───────────┼──────────────────────────────────────┤
│ *      │ DEFAULT │ me@example.com      │ oauth   │ yes       │ ~/.config/neon/credentials.json      │
├────────┼─────────┼─────────────────────┼─────────┼───────────┼──────────────────────────────────────┤
│        │ work    │ me@work.example.com │ api key │ yes       │ ~/.config/neon/credentials.work.json │
└────────┴─────────┴─────────────────────┴─────────┴───────────┴──────────────────────────────────────┘
```

Select one per invocation with `--profile`, or per shell with `NEON_PROFILE`. There is no `profile use` command and nothing is stored about which profile is "current", so what you type is always what runs.

Entries in `profiles.json` are paths, and a path may point anywhere — which is how you adopt a directory you already have, without moving or re-authenticating anything:

```json
{
  "version": 1,
  "profiles": {
    "DEFAULT": { "credentials": "credentials.json" },
    "work": { "credentials": "../neonctl-work/credentials.json" }
  }
}
```

`neon profiles remove` revokes the refresh token at the authorization server, not just locally. It deletes the credentials file only when the CLI created it: an adopted path like the one above is unlinked and left on disk, and the command says so. Removing the last named profile deletes `profiles.json`, returning you to the single-account layout. `neon profiles remove DEFAULT` signs you out.

## API keys (`api-keys`)

```bash
neon api-keys list                                        # your account's keys
neon api-keys list --org-id org-…                         # an organization's, with scope shown

neon api-keys create --name ci                            # account key
neon api-keys create --name ci    --org-id org-…          # organization key
neon api-keys create --name agent --project-id frosty-…   # can access only that project

neon api-keys revoke <id> [--org-id org-…]
```

The key is returned once, on create, and cannot be retrieved again. It prints on its own line below the table, so it can be selected in one gesture regardless of terminal width — and `… | tail -1` on stdout yields exactly the key, since both notices go to stderr.

```console
$ neon api-keys create --name agent --project-id proj-in-org
API key
┌─────┬───────┬─────────────┐
│ Id  │ Name  │ Project     │
├─────┼───────┼─────────────┤
│ 303 │ agent │ proj-in-org │
└─────┴───────┴─────────────┘

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
┌─────┬──────────┬────────────────┬──────────────────────┬──────────────────────┬─────────────────────┐
│ Id  │ Name     │ Project        │ Created At           │ Last Used At         │ Last Used From Addr │
├─────┼──────────┼────────────────┼──────────────────────┼──────────────────────┼─────────────────────┤
│ 301 │ scoped   │ proj-in-org    │ 2026-01-02T00:00:00Z │                      │                     │
├─────┼──────────┼────────────────┼──────────────────────┼──────────────────────┼─────────────────────┤
│ 302 │ org-wide │ (all projects) │ 2026-01-03T00:00:00Z │ 2026-02-03T00:00:00Z │ 203.0.113.9         │
└─────┴──────────┴────────────────┴──────────────────────┴──────────────────────┴─────────────────────┘
```

`last_used_at` and `last_used_from_addr` are how you spot a key worth revoking.

### A profile can hold an API key instead of an OAuth session

`neon auth` signs a profile in through the browser. `neon profile set-key` gives it an API key instead, which is what you want for an agent, a shared machine, or anything that must never be interrupted by a login:

```bash
neon profile set-key work                                # prompts, so the key stays out of shell history
neon profile set-key work --api-key napi_...             # non-interactive
neon profile set-key work --api-key-file ~/keys/work     # take it from a file you already have
neon profile rotate-key work                             # mint a fresh key, revoke the one it replaces
```

`set-key` verifies the key against the API before storing it, and records who it belongs to so `profile list` can show you. It creates the profile if it does not exist yet and replaces the key if it does. Only a real API key is accepted — an OAuth access token authenticates today and then expires with nothing to refresh it, so it is refused rather than stored.

`rotate-key` mints with whatever the profile can currently authenticate with, so a profile that has both a key and the OAuth session it was minted from can be rotated without a browser. It stores the new key before revoking the old one: if the write fails, the old key still works.

The credentials file says which kind it holds, and `type` is what decides — not which fields happen to be present:

```json
// oauth: what `neon auth` writes. An absent `type` means this.
{ "access_token": "…", "refresh_token": "…", "expires_at": 1786…, "user_id": "…" }

// api_key: what `set-key` writes
{ "type": "api_key", "api_key": "napi_…", "user_id": "…" }

// api_key minted by `rotate-key`, keeping the session it came from for the next rotation
{ "type": "api_key", "api_key": "napi_…", "key_id": 123, "user_id": "…",
  "access_token": "…", "refresh_token": "…", "expires_at": 1786… }
```

The secret stays in that file and never goes into `profiles.json`, so listing profiles cannot leak one. Both files are written owner-only through a temporary file and a rename, which also repairs the permissions of a file that was created too permissively.

Two things `rotate-key` cannot do for a key you supplied yourself. It cannot revoke it — `GET /api_keys` exposes no prefix, so a stored secret cannot be matched to a listing entry, and the command tells you to check `neon api GET /api_keys` instead. For the same reason `profile remove` leaves an API key live upstream, and says so.

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

`neon auth` and the `profile` subcommands are outside all of this, because they read the same flags to mean something else: `neon auth --profile work` names where to write a credential, and `neon profile set-key work --api-key …` names one to store.

`neon init` does not support `--profile` yet. It hands its whole auth flow to `neon-init`, which reads the default credentials directly, so passing the flag fails instead of quietly running as the default account.

## Commands

| Command                                                                    | Subcommands                                                                                                  | Description                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| [auth](https://neon.com/docs/reference/cli-auth)                           |                                                                                                              | Authenticate                       |
| profiles                                                                   | `list`, `create`, `rotate-key`, `remove`                                                                     | Manage named sets of credentials   |
| api-keys                                                                   | `list`, `create`, `revoke`                                                                                   | Manage API keys                    |
| [projects](https://neon.com/docs/reference/cli-projects)                   | `list`, `create`, `update`, `delete`, `get`                                                                  | Manage projects                    |
| [ip-allow](https://neon.com/docs/reference/cli-ip-allow)                   | `list`, `add`, `remove`, `reset`                                                                             | Manage IP Allow                    |
| [me](https://neon.com/docs/reference/cli-me)                               |                                                                                                              | Show current user                  |
| [branches](https://neon.com/docs/reference/cli-branches)                   | `list`, `create`, `rename`, `add-compute`, `set-default`, `set-expiration`, `delete`, `get`                  | Manage branches                    |
| [databases](https://neon.com/docs/reference/cli-databases)                 | `list`, `create`, `delete`                                                                                   | Manage databases                   |
| function                                                                   | `deploy`, `list`, `get`, `delete`                                                                            | Manage Neon Functions              |
| [roles](https://neon.com/docs/reference/cli-roles)                         | `list`, `create`, `delete`                                                                                   | Manage roles                       |
| [operations](https://neon.com/docs/reference/cli-operations)               | `list`                                                                                                       | Manage operations                  |
| snapshots                                                                  | `list`, `get`, `create`, `update`, `delete`, `restore`, `finalize`, `schedule get`, `schedule set`           | Manage snapshots                   |
| [connection-string](https://neon.com/docs/reference/cli-connection-string) |                                                                                                              | Get connection string              |
| [psql](https://neon.com/docs/reference/cli-psql)                           |                                                                                                              | Connect to a database via psql     |
| set-context                                                                |                                                                                                              | Deprecated; use `link`             |
| env                                                                        | `pull`                                                                                                       | Manage a branch's env vars         |
| checkout                                                                   |                                                                                                              | Pin a branch in `.neon`            |
| diff                                                                       |                                                                                                              | Git-style schema diff vs a branch  |
| [link](https://neon.com/docs/reference/cli-link)                           |                                                                                                              | Link a directory to a project      |
| config                                                                     | `init`, `status`, `plan`, `apply`                                                                            | Drive a branch from `neon.ts`      |
| deploy                                                                     |                                                                                                              | Alias for `config apply`           |
| bootstrap                                                                  |                                                                                                              | Scaffold a project from a template |
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

  Specifies the path to the `neon` configuration directory, which holds the `credentials.json` written by `neon auth`. The default is `$XDG_CONFIG_HOME/neon`, or `~/.config/neon`; run `neon --help` to see the resolved path. This option is only necessary if you keep your configuration somewhere else.

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

  Specifies your Neon API key. You can authenticate using a Neon API key when running a Neon CLI command instead of using `neon auth`. For information about obtaining an Neon API key, see [Authentication](https://api-docs.neon.tech/reference/authentication), in the _Neon API Reference_.

  ```bash
  neon <command> --api-key <neon_api_key>
  ```

- <a id="analytics"></a>`--analytics`

  Analytics are enabled by default to gather information about the CLI commands and options that are used by our customers. This data collection assists in offering support, and allows for a better understanding of typical usage patterns so that we can improve user experience. Neon does not collect user-defined data, such as project IDs or command payloads. To opt-out of analytics data collection, specify `--no-analytics` or `--analytics false`.

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
