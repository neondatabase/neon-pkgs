---
"@neon/config": minor
"@neon/config-runtime": minor
"@neon/env": minor
"neon": minor
---

A Function `env` value in `neon.ts` can be a declaration instead of a string: `{ value: process.env.X, required: true }`, with `required: false` or `required: "default-branch"` for a value that may be unset, and `onUndefined: "skip"` to keep the deployed value instead of removing it. A declaration's value is checked only when `neon deploy`, `neon dev`, or `parseEnv` needs it, so importing `neon.ts` (from app code or another Function) no longer fails on a secret it does not hold.
