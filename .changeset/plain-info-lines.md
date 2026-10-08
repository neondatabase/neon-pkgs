---
"neon": patch
---

Informational lines on stderr no longer start with `INFO:`. Results, negative answers such as `neon config status --current-branch` printing "No branch pinned", progress, and next steps print plain; only `WARNING:` and `ERROR:` keep a prefix. A failed best-effort API key revocation (for example during `neon profile remove`) now prints `WARNING:` with the command to revoke it by hand, and `neon checkout` in a terminal no longer prints `ERROR:` before asking whether to create a missing branch or link a project.
