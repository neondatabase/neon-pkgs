---
"neon": minor
---

`neon functions new` and `neon config add function` declare a template's env as `{ value: process.env.X, required }` in `neon.ts`, using the `required` a registry template sets (default `true`). A project with an installed `@neon/config` older than 1.13.0 keeps getting `process.env.X!`, with a warning to upgrade.
