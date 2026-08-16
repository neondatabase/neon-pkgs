---
"neon": minor
"@neon/env": minor
---

Opt-in OS keyring storage for a CLI profile via a `"keyring"` pointer in `profiles.json`. `neon profile create` no longer takes `--force`: creating an existing name replaces it and revokes the credential it held.
