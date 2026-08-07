---
"neon": patch
---

Stop reporting an empty or borrowed identity in CLI telemetry.

A command can reach telemetry with nothing having identified it — no API key, and no readable
credentials file to fall back on, which is the normal state in CI and on a fresh machine. The
internal user id is `""` there, and three things went out wrong:

- `identify` fell back with `?? "anonymous"`. `""` is not nullish, so it sent `userId: ""`, an
  identify carrying no identity. Segment forwards that rather than rejecting it.
- The `cli_command_success` event reported `accountId: ""` under `authMethod: "oauth"`, naming
  a method for a run where nothing authenticated. Both fields are now omitted unless a
  credential actually named the account.
- A key passed as `--api-key` or `NEON_API_KEY` records no credentials file, so telemetry read
  `DEFAULT`'s and attributed the run to whoever was signed in locally — then skipped the API
  lookup that would have resolved the key's real owner. Such runs are now identified by the
  key's own account.

No user-visible behavior changes: this only affects what the CLI reports about itself.
