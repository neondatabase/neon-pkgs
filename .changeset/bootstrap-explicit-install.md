---
"neon": patch
---

`neon bootstrap --install` now installs dependencies when run without a terminal, such as from a coding agent or CI, instead of skipping the install. A failed install exits with an error. Without `--install` or `--default`, a non-interactive run still only scaffolds.
