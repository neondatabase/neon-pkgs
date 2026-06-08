---
"@neondatabase/config-runtime": minor
---

`apply` / `pushConfig` now accept an optional `bundleFunction` ({@link FunctionBundler}) so the caller can supply its own function bundler. When omitted, the default lazily `import()`s the esbuild-backed `buildFunctionBundle`, keeping esbuild out of `config-runtime`'s static module graph — so a consumer that injects its own bundler (e.g. neonctl, which already ships esbuild) never drags a second copy into its packaged snapshot. Exports the `FunctionBundler` type from `v1`.
