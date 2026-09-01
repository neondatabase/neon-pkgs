# `@neon-internals/env-core`

Resolving a branch's env from the Neon API, and the credential reuse that has to wrap it.
Shared by the two things that do it: `@neon/env` (which publishes `fetchEnv` and `toEntries`
from here) and the `neon` CLI (`env pull`, `dev`, `link`, `checkout`, `config apply`).

| File | What |
| --- | --- |
| `env.ts` | `fetchEnv`, `NEON_ENV_VAR_KEYS`, the `NeonEnv` shapes, `toEntries` |
| `reuse-secrets.ts` | `fetchEnvReusingSecrets` — verify persisted one-time secrets, mint and revoke only when it must |

`parseEnv` is deliberately **not** here. It reads `process.env`, only `@neon/env` needs it, and
keeping it out keeps `zod` out of every consumer that bundles this package.

## Why `fetchEnvReusingSecrets` is not published

It used to be, at `@neon/env/runtime`, and that was a mistake worth not repeating. It reads an
env source and can mint and revoke branch credentials — a library that revokes your credentials
because you imported it is a library you cannot safely embed. Its only consumers are our own
two CLIs. A private package is what that is; a published subpath was a way of moving it between
packages, and the wrong one.

## It is private, and bundled into each consumer

Same mechanism and the same reasons as
[`@neon-internals/cli-core`](../cli-core/README.md): both consumers list it in
`devDependencies` and build with tsdown bundling on, so it is compiled into each `dist` and
resolves nothing at runtime.

## Importing it

Per-file subpaths, and **no root export** — there is deliberately no barrel, so a consumer takes
only what it names and the rest is tree-shaken out of their bundle. That matters most here:
`env.ts` is safe to import and `reuse-secrets.ts` mints and revokes credentials, and nothing
should reach the second by asking for the first. `@neon-internals/env-core` on its own answers
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

The specifier is **extensionless**, unlike every relative import in this repo:

```ts
import { fetchEnv } from "@neon-internals/env-core/env";     // resolves
import { fetchEnv } from "@neon-internals/env-core/env.js";  // dist/env.js.js
```

In `packages/cli` the `.js` form passes `tsc --noEmit` — its `paths` mapping plus tsc's
`.js`-to-`.d.ts` substitution hides it — and fails at bundle time instead. `packages/env` is on
`NodeNext` and rejects it at both.

## Rules

- **`@neon/config` is the only dependency.** Both consumers already have it. Anything else you
  import becomes a runtime dependency of both, so add one only deliberately — that is why
  `parseEnv` and its `zod` schemas stayed behind in `@neon/env`.
- Tests live in `packages/env` (`env.test.ts`, `reuse-secrets.test.ts`, the contract and type
  tests), so this code is covered once rather than in both consumers.
