---
"neon": patch
---

`neon plugins` and the plugin step of `neon init` and `neon bootstrap` now stop with one error that names git when `git` is missing or does not run, instead of failing every agent with a plugins CLI error such as "Repository not found".
