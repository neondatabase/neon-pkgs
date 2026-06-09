---
"@neondatabase/config-runtime": patch
---

Name the function bundle entry `index.mjs` instead of `out.js`.

`buildFunctionBundle` emitted the esbuild output as `out.js` / `out.js.map`, but the Functions
runtime imports the deploy archive's entry by the conventional `index.{js,mjs}` name — so a
deployed function's zip had no importable module. The default bundler now emits
`index.mjs` / `index.mjs.map`.
