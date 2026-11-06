---
"@neon/config": minor
"@neon/config-runtime": minor
"@neon/env": minor
"neon": minor
---

A Function `env` value in `neon.ts` can be a declaration instead of a string: `{ required: true }`, `{ required: "deploy" }`, `{ required: false, ifUnset?: "delete" | "keep" }`, or `{ default: "<value>" }`. A declaration reads `process.env.<key>` only when `neon deploy`, `neon dev`, or `parseEnv` needs it, so importing `neon.ts` (from app code or another Function) no longer fails on a secret it does not hold. `plan`, `apply`, and `createBranch` take an `env` source.
