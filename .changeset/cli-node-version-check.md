---
"neon": patch
---

On Node.js older than 20.19, `neon` now exits with `neon requires Node.js 20.19 or newer (found <version>).` instead of crashing inside a dependency (`crypto is not defined`, `File is not defined`).
