---
"neon": minor
"@neon/env": minor
"neon-init": patch
"@neon/config": minor
---

`neon profile create`, including API-key profiles, and an explicit `--profile` is no longer ignored

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
  `neon-init`'s case, offered a browser sign-in that would overwrite it.
- **A malformed credentials file no longer echoes its own contents.** `JSON.parse` quotes a window
  of the input around a syntax error, so a truncated credentials file produced
  `Unexpected token 'a', ..."api_key":napi_SUPERS"... is not valid JSON` — printed by
  `profile list` and by every failed authentication. Diagnostics now name the file and nothing
  from inside it.
- A file declaring `"type": "api_key"` without a key is reported as invalid rather than as a
  working key profile, and no revocation is attempted for it. `list` showed it as usable, and
  `remove` sent an empty credential to the revoke endpoint and reported the failure as if the key
  might still be live.
- A malformed `profiles.json` is never rewritten. It was treated as absent, so `profile create`
  rebuilt it from a single `DEFAULT` entry and discarded every named profile in it — the file is
  the only record of where each account's credentials live. Reading still tolerates it, so
  `neon auth` keeps working, but a named profile now reports the broken file rather than
  `Unknown profile`, and entry names and paths are validated as they are read.

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
