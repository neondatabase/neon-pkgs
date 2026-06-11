---
"@neondatabase/config-runtime": patch
---

Bundle function dependencies into the deploy archive.

The default function bundler (`buildFunctionBundle`) ran esbuild with `--packages=external`, so npm dependencies were left as bare imports and never shipped. Since the Functions runtime has no `node_modules`, any function importing a third-party package failed to load at runtime (`Cannot find package '…'`).

It now bundles dependencies into `index.mjs` (Node built-ins stay external on `platform: "node"`) and prepends a `createRequire` banner so bundled CommonJS dependencies work inside the ESM output (avoids `Dynamic require of "fs" is not supported`).
