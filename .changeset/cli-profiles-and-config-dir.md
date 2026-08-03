---
"@neon/config": minor
"@neon/env": patch
"neon-init": patch
"neon": minor
"neonctl": minor
---

Add `neon profile`, and move the config directory to `~/.config/neon`

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
