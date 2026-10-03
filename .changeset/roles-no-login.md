---
"neon": patch
---

`neon roles create --no-login` now creates a role that cannot log in. Before, the flag was ignored and the role was created with a password; only `--no-login=true` worked.
