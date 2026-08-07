---
"neon": patch
---

Report the account a run actually authenticated as in CLI telemetry, and stop making an API
request to build a telemetry event.

- A run authenticated with `--api-key` or `NEON_API_KEY` was reported under the identity of
  whoever was signed in locally, rather than the key's own account.
- `neon profile …`, `neon config init`, `neon auth` and a bare `neon` do not authenticate through
  the global auth middleware, but an ambient `NEON_API_KEY` was still sent to `/api/v2/auth` to
  label their telemetry. That request is gone.
- A run with no usable credentials reported an empty account under `authMethod: "oauth"`, and an
  empty string as its identity. It now reports neither account nor method, and identifies the run
  as `anonymous`.
