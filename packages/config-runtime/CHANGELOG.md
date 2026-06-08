# @neondatabase/config-runtime

## 0.2.0

### Minor Changes

- 135a173: `apply` / `pushConfig` now accept an optional `bundleFunction` ({@link FunctionBundler}) so the caller can supply its own function bundler. When omitted, the default lazily `import()`s the esbuild-backed `buildFunctionBundle`, keeping esbuild out of `config-runtime`'s static module graph — so a consumer that injects its own bundler (e.g. neonctl, which already ships esbuild) never drags a second copy into its packaged snapshot. Exports the `FunctionBundler` type from `v1`.
- 5ddace9: `pullConfig` now reverse-engineers the branch's **Neon Auth** and **Data API** enablement into the returned `config` (`config.auth = {}` / `config.dataApi = {}` when each integration is enabled on the branch). Previously only branch/postgres settings and the `preview` block (buckets, functions, AI Gateway) were surfaced, so a config pulled from a branch with Auth or Data API enabled did not round-trip through `resolveConfig` / `fetchEnv` — and the matching `NEON_AUTH_BASE_URL` / `NEON_DATA_API_URL` secrets were never injected. Data API is enabled per branch + database, so `pullConfig` probes the branch's default database (`neondb`, else the first database) to detect it.

## 0.1.0

### Minor Changes

- Initial release of `@neondatabase/config-runtime` — the imperative runtime for `@neondatabase/config`. Reads a branch's live state, diffs a policy against it, applies changes, and bundles + deploys Neon Functions. Function bundling pulls in `esbuild`, so this is the package CLIs and CI import — keeping `esbuild` out of the dependency tree of anyone who only imports `defineConfig` from `neon.ts`.

  - `inspect` / `plan` / `apply` (Terraform-style), plus the lower-level `pushConfig` / `pullConfig` engine.
  - Preview features are applied **additively** (buckets and functions are created and the AI Gateway is enabled; nothing is auto-deleted), and `inspect` / `pullConfig` reports a branch's live Preview state.
  - `buildFunctionBundle` — bundles a function's `source` with esbuild and zips it for deploy.
