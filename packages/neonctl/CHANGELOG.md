# neonctl

## 4.10.1

### Patch Changes

- Updated dependencies [7c6ec56]
  - neon@4.10.1

## 4.10.0

### Patch Changes

- Updated dependencies [33aac59]
  - neon@4.10.0

## 4.9.0

### Patch Changes

- Updated dependencies [64d0333]
  - neon@4.9.0

## 4.8.0

### Minor Changes

- 599c69c: `neon link --project-id` pins the project's only branch. Several branches prompt in a TTY, pin the default with `-y`, or stay unpinned for `neon checkout`.
- 53b2e72: `neon init` in an empty directory is `neon bootstrap` (scaffold, agent tooling, link). In an existing app it installs a plugin or skills+MCP, links, then writes neon.ts. `neon bootstrap` offers the same agent tooling after scaffolding; `--default` also runs `link --yes`.

### Patch Changes

- Updated dependencies [599c69c]
- Updated dependencies [53b2e72]
  - neon@4.8.0

## 4.7.1

### Patch Changes

- neon@4.7.1

## 4.7.0

### Minor Changes

- 9530c77: `neon link --agent` is removed. List orgs with `orgs list --output json` and projects with `projects list --org-id <org-id> --output json`. Link with `--project-id`, or create with `--org-id --project-name --region-id`.

### Patch Changes

- Updated dependencies [9530c77]
  - neon@4.7.0

## 4.6.0

### Minor Changes

- e6a4174: `neon bootstrap --agent` is removed. List templates with `--list-templates --output json` (or yaml). Scaffold with `--template` or `--default`.

### Patch Changes

- Updated dependencies [e6a4174]
  - neon@4.6.0

## 4.5.2

### Patch Changes

- e869e9e: `neon skills --help`, `neon mcp --help`, and `neon plugins --help` list supported agents and the install catalogs: skill ids with source repos, the `neon-postgres` plugin contents, and the MCP server URL plus `neon mcp -y` defaults.
- Updated dependencies [e869e9e]
  - neon@4.5.2

## 4.5.1

### Patch Changes

- neon@4.5.1

## 4.5.0

### Patch Changes

- Updated dependencies [512baf3]
  - neon@4.5.0

## 4.4.0

### Minor Changes

- bdb0db6: Add `neon plugins` to install the Neon agent plugin into coding agents. A TTY asks agents, then confirms. `-y` installs into detected agents at project scope. `--agent` names specific agents. `--global` is user scope.

### Patch Changes

- Updated dependencies [bdb0db6]
- Updated dependencies
  - neon@4.4.0

## 4.3.1

### Patch Changes

- 894b427: `neon mcp` mints a project-scoped API key when `--project-id` is set or a linked project is pinned, instead of an account-wide key.
- Updated dependencies [894b427]
  - neon@4.3.1

## 4.3.0

### Minor Changes

- eb52252: Add `neon skills` to install Neon agent skills into coding agents. A TTY asks agents and skills, then confirms. `-y` installs the default skills into detected agents in this directory. `--skill` names specific skills. `--global` is user-level. `neon skills update` refreshes installed skills.

### Patch Changes

- Updated dependencies [eb52252]
  - neon@4.3.0

## 4.2.1

### Patch Changes

- 9c5ecf5: List commands print every populated column at full width on one line per row. A narrow terminal wraps the line instead of dropping or truncating columns. `neon branches list` and `neon snapshots list` show Expires At before Created At, including on get and create. `neon projects list --recoverable-only` shows Recoverable Until before Deleted At.
- Updated dependencies [9c5ecf5]
  - neon@4.2.1

## 4.2.0

### Minor Changes

- 55f4bf2: Add `neon mcp` to install the Neon MCP server into coding agents. A TTY asks config location (global default), agents, API key vs OAuth, then confirms. Linked project-folder installs also ask whether to pin tools to that project. `-y` is global, detected agents, minted write API key. `--project` is config location only. `--read-only`, `--project-id` and `--category` set MCP URL query params. The minted key is always account-wide.

### Patch Changes

- Updated dependencies [55f4bf2]
  - neon@4.2.0

## 4.1.0

### Patch Changes

- Updated dependencies [6ff43d7]
  - neon@4.1.0

## 4.0.0

### Major Changes

- d606a2e: `neon neon-auth config email-provider test` now sends through the custom SMTP provider saved on the branch. Only `--recipient-email` is accepted; `--host`, `--port`, `--username`, `--password`, `--sender-email`, and `--sender-name` are rejected. Save the provider first with `neon neon-auth config email-provider update --type standard`.

### Patch Changes

- Updated dependencies [d606a2e]
  - neon@4.0.0

## 3.6.1

### Patch Changes

- neon@3.6.1

## 3.6.0

### Minor Changes

- 23740cd: `neon` list and get commands no longer draw box-drawing tables. Default output is space-padded columns that drop and truncate to the terminal width, or stacked `Label  value` lines for a single object. `--output json` and `--output yaml` keep the same fields; `neon profile list` reports OAuth scope as `account` in every format.

### Patch Changes

- Updated dependencies [23740cd]
- Updated dependencies [e78f193]
  - neon@3.6.0

## 3.5.1

### Patch Changes

- neon@3.5.1

## 3.5.0

### Patch Changes

- Updated dependencies [745c267]
  - neon@3.5.0

## 3.4.0

### Patch Changes

- Updated dependencies [5abe208]
  - neon@3.4.0

## 3.3.0

### Patch Changes

- Updated dependencies [0b37ad5]
  - neon@3.3.0

## 3.2.2

### Patch Changes

- Updated dependencies [e8715cd]
  - neon@3.2.2

## 3.2.1

### Patch Changes

- Updated dependencies [ad7cf9a]
  - neon@3.2.1

## 3.2.0

### Patch Changes

- Updated dependencies [998728b]
  - neon@3.2.0

## 3.1.1

### Patch Changes

- Updated dependencies [7bb17a9]
  - neon@3.1.1

## 3.1.0

### Patch Changes

- Updated dependencies [5305087]
- Updated dependencies [9f51632]
  - neon@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [3cb16e1]
- Updated dependencies [98c4aec]
- Updated dependencies [4497de8]
- Updated dependencies [98c4aec]
  - neon@3.0.0

## 2.47.0

### Patch Changes

- Updated dependencies [6f8ba4d]
- Updated dependencies [47e6728]
  - neon@2.47.0

## 2.46.0

### Patch Changes

- Updated dependencies [ecd588f]
- Updated dependencies [4b9fd02]
  - neon@2.46.0

## 2.45.0

### Patch Changes

- Updated dependencies [304bc8f]
- Updated dependencies [f549c10]
  - neon@2.45.0

## 2.44.0

### Patch Changes

- Updated dependencies [aa31410]
  - neon@2.44.0

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

- Updated dependencies [48b274f]
- Updated dependencies [48b274f]
- Updated dependencies [7cbeead]
  - neon@2.43.0

## 2.42.0

### Patch Changes

- Updated dependencies [6648f8c]
  - neon@2.42.0

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
  - neon@2.41.0

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
