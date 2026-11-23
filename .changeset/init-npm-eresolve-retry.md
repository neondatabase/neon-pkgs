---
"neon": patch
---

When npm cannot add `@neon/config` and `@neon/env` because the project already has a peer dependency conflict (`ERESOLVE`), `neon init`, `neon config init`, and `neon config add` now print `npm install --force @neon/config @neon/env` as the retry, with a line saying why, instead of repeating the command that failed.
