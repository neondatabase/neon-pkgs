---
"neon": patch
---

Describe a CLI run in telemetry only with the credential that actually authorized it.

Three defects, all from the same cause — the internal user id and the key to ask the API about
were chosen by separate expressions, neither of which asked whether the invocation had
authenticated at all:

- Nothing identified the run, which is the normal state in CI and on a fresh machine, and also
  whenever a credentials file exists but records no `user_id`. `identify` fell back with
  `?? "anonymous"`; `""` is not nullish, so it sent `userId: ""`, an identify carrying no
  identity, which Segment forwards rather than rejecting. `cli_command_success` reported
  `accountId: ""` under `authMethod: "oauth"`, naming a method for a run that authenticated with
  nothing. Both fields are now omitted unless a credential named the account.
- A key selected from `--api-key` or `NEON_API_KEY` records no credentials file, so telemetry
  read `DEFAULT`'s and identified the run as whoever was signed in locally — then skipped the API
  lookup that would have named the key's own account. Such runs are now identified by the key.
- A command the global auth middleware skips — `profile`, `config init`, `auth`, `--help`, a bare
  `neon` — left an ambient `NEON_API_KEY` in play, so telemetry both read `DEFAULT`'s id and
  queried that key, mixing two accounts into one event and adding an API request purely to build
  it. The key is now ignored for those commands, and no telemetry request is made.

No user-visible behavior changes: this only affects what the CLI reports about itself, and
removes a telemetry-only API request from the commands the auth middleware skips.
