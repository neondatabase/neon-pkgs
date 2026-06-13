---
"@neondatabase/config-runtime": patch
---

Stop generating a source map for deployed function bundles.

`buildFunctionBundle` ran esbuild with `sourcemap: true`, shipping an `index.mjs.map` in every deploy archive. The Functions runtime does not run Node with source-map support, so the uploaded map is never consumed (a thrown error's stack still points into the minified `index.mjs`). It only inflated the archive, so it is no longer emitted.
