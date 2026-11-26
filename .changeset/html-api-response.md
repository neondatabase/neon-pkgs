---
"@neon/sdk": patch
"neon": patch
---

When a host answers with a 2xx HTML page instead of the Neon API, for example an `--api-host` that points at a web app or a proxy page, `@neon/sdk` now returns a `NeonClientError` that names the URL. `neon projects list` prints that error instead of crashing with a `TypeError`, and commands such as `neon orgs list` no longer print empty results.
