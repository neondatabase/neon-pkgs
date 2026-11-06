---
"@neon/config": minor
"@neon/config-runtime": minor
"@neon/env": minor
"neon": minor
---

A Function `env` value in `neon.ts` can be a declaration instead of a string: `{ value: process.env.X }` (required), with `required: "default-branch"`, `required: false`, or `default: "<fallback>"`. `value` defaults to `process.env.<key>`. A declaration is resolved only when `neon deploy`, `neon dev`, or `parseEnv` needs it, so importing `neon.ts` (from app code or another Function) no longer fails on a secret it does not hold. `plan`, `apply`, and `createBranch` take an `env` source.
