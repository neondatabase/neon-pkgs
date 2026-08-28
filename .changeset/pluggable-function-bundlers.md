---
"@neon/config": minor
"@neon/config-runtime": minor
"neon": minor
---

Add a per-function `bundler` option so a function's `source` can be shipped without esbuild.

`neon.ts` functions accept `bundler`, defaulting to `"esbuild"`. A directory source is bundled from the first of `index.ts`, `index.js`, `index.mjs`. Set `"none"` to zip a prebuilt directory (or a single `index.mjs` / `index.js` file) as-is. `neon function deploy --no-bundle` is the CLI form. An inline `(fn) => Promise<FunctionBundle>` still bundles arbitrarily. `externalPackages` remains esbuild-only.
