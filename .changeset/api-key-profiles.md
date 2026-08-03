---
"neon": minor
"@neon/env": patch
"neon-init": patch
---

A profile can hold an API key, and an explicit `--profile` is no longer silently ignored

Profiles could only hold an OAuth session, so the accounts that most need one — an agent, a
shared machine, CI — could not use them. Worse, any API key voided the selection without
saying so: `ensureAuth` returned as soon as `--api-key` or `NEON_API_KEY` was set, before the
profile was resolved, so `neon --profile work …` ran as whoever the ambient key belonged to and
reported nothing.

```bash
neon profile set-key work                              # prompts, so the key stays out of history
neon profile set-key work --api-key-file ~/keys/work   # or adopt a file you already have
neon profile rotate-key work                           # mint a fresh key, revoke the one it replaces
neon --profile work projects list                      # no browser, ever
```

`set-key` verifies the key against the API before storing it and records who it belongs to, so
`profile list` gains an `Auth` column showing `api key` or `oauth`. It accepts only a real API
key: an OAuth access token would authenticate and then expire with nothing to refresh it.
`rotate-key` mints with whatever the profile can already authenticate with, so a profile keeping
the session its key was minted from rotates without a browser.

**`profiles.json` is unchanged.** A profile is still one name and one pointer; the file it points
at now declares its own `type`, and the two shapes are supersets rather than alternatives — an
`api_key` file may retain the OAuth token set it was minted from, and an OAuth file may retain
the `key_id` of a key that is still live upstream. `type` decides what authenticates, never which
fields happen to be present. An older CLI reads a minted profile's `access_token` and still works.

**Precedence now follows one rule: an explicit flag beats an environment variable.** `--profile`
wins over `NEON_API_KEY`, `--api-key` wins over `NEON_PROFILE`, passing both flags fails instead
of picking a winner, and two ambient sources still resolve to the key — so a pipeline injecting
`NEON_API_KEY` is unaffected — but the disregarded profile is now named on stderr.

This is a behaviour change: `neon --profile x` in an environment that exports `NEON_API_KEY` now
resolves the profile, and fails with `Unknown profile "x"` when there is no such profile, where
before the ambient key made it appear to work.

Fixed alongside it, all in the same area:

- A 401 no longer deletes the wrong account's credentials. The handler had only the config
  directory, so a rejected token on a `--profile`-selected account cleared whatever `DEFAULT`
  pointed at. It now acts on the exact file that failed, and never deletes an API key — there is
  nothing to refresh, so deleting it would destroy the only copy. The message names the profile
  and the file.
- Analytics attributed every `--profile` command to the default account, because it read
  `DEFAULT`'s credentials regardless of what the invocation authenticated with.
- `neon bootstrap` passed the resolved key to the `neon link` it re-executes, putting a secret in
  the child's process list and stripping it of the profile it came from. It now forwards
  `--profile` and `--config-dir`, the latter having never been forwarded at all.
- `neon init` rejects `--profile` instead of ignoring it. It delegates auth to `neon-init`, which
  reads the default credentials directly, so honouring the flag is not possible yet — and running
  as the default account is worse than refusing when the flag's whole job is to name an account.
- `@neon/env` and `neon-init` read the stored credential's `type`, so a key-backed account is no
  longer reported as having no credentials at all.
- Credentials and `profiles.json` are written through a temporary file and a rename.
  `writeFileSync`'s `mode` applies only when it creates a file, so an existing credentials file
  kept whatever permissions it already had — a file created `0700` by a release before `0600`
  became the default stayed `0700` indefinitely. Every write now lands owner-only on a fresh
  inode, and there is no window where the file is readable at default permissions.
