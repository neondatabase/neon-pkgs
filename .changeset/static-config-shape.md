---
"@neondatabase/config": major
"@neondatabase/config-runtime": major
"@neondatabase/env": major
---

Reshape `defineConfig` into a static existential set + a tuning-only `branch` closure.

**Breaking.** `defineConfig` now takes an **object**, not a function:

```ts
export default defineConfig({
  auth: true,
  dataApi: false,
  preview: {
    aiGateway: false,
    functions: {
      hello: { name: "Hello", source: "./functions/hello.ts", dev: { port: 8787 } },
    },
    buckets: { uploads: { access: "public_read" } },
  },
  branch: (branch) => ({
    protected: branch.name === "main",
    preview: { functions: { hello: { memoryMib: 1024 } } },
  }),
});
```

- GA service toggles (`auth`, `dataApi`) and the beta `preview` block (`aiGateway`,
  `functions`, `buckets`) are **static and top-level**, so the secret set is known at the
  type level. `functions`/`buckets` are **records keyed by slug/name** (regex-enforced,
  dup-free).
- The `branch` closure is **tuning-only** (`parent`/`ttl`/`protected`/`postgres` + per-function
  `memoryMib`/`runtime`), and is type-constrained to only reference declared function slugs.
  It cannot add or remove services or functions.
- `resolveConfig` still returns the same `ResolvedBranchConfig`, so `diff`/`plan`/`apply`
  are unchanged at runtime. `pullConfig` now returns the new `Config` shape.
- `@neondatabase/env`: `NeonEnv<C>` is derived directly from the static toggles, so it is
  exact. `parseEnv` drops the `branchName` argument and takes an optional **scope** — omit
  for external env, or pass a function slug to also get a typed `function` namespace of that
  function's declared env keys.
