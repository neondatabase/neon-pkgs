---
"neon": minor
---

Improve `neon init` onboarding and make `.neon` context writes non-destructive:

- Detect and install the `neon` CLI during init, not the retired `neonctl` alias.
- Use `neon link` to create/link the project and write `.neon` (branch included) instead of hand-editing it.
- Writing `.neon` via `link`, `checkout`, or `set-context` now preserves unrelated fields; `neon link --clear` still resets it.
- Update init's doc links, and suggest `neon psql` as a quick connection check.
