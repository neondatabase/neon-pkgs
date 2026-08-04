---
"neon": minor
"@neon/env": patch
"neon-init": patch
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

`profile list` gains `Auth` and `Scope` columns, and `SignedIn` becomes `Available` — a file
existing never proved a credential valid, and for a key there is no session to be in.

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
- Credentials and `profiles.json` are written through a temporary file and a rename.
  `writeFileSync`'s `mode` applies only when it creates a file, so an existing credentials file
  kept whatever permissions it already had — one created `0700` by a release before `0600` became
  the default stayed `0700` indefinitely. Every write now lands owner-only on a fresh inode.
- `readCredentials` treats only a missing file as "no credentials". A permission or I/O error used
  to look identical to absence, so it would start a browser login that overwrote a credential the
  CLI simply could not read.
