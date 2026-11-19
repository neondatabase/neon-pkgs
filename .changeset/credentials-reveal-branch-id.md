---
"neon": patch
---

`neon credentials reveal` now prints the credential's `branch_id`, `name`, and `scopes` next to its secrets, as `create` and `rotate` do. When the branch you pass does not list the credential, it prints the secrets without that metadata and warns.
