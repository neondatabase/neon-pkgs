---
"neon": patch
"neonctl": patch
---

`neon functions new` now saves a template's dependencies at the exact version the template pins (`-E`), instead of the package manager's default caret range. The printed install command does the same.
