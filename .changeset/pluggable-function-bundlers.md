---
"@neon/config": minor
"@neon/config-runtime": minor
"neon": minor
---

Add a per-function `bundler` option so a function's `source` can be bundled however its toolchain requires, not only with esbuild.

`neon.ts` functions accept `bundler`, defaulting to `"esbuild"` (unchanged behavior). Set `"zip-directory"` to ship a prebuilt output directory as-is — for a framework whose own build already emits a runnable directory (e.g. `mastra build`) — or pass an inline `(fn) => Promise<FunctionBundle>` to bundle arbitrarily. A non-esbuild bundler accepts a directory `source` and is served the same way under `neon dev`, so a local run exercises the exact bundle a deploy ships. The deploy-side `bundleFunction` escape hatch on `apply` / `pushConfig` still overrides everything.
