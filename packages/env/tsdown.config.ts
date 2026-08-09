import { defineConfig } from "tsdown";

export default defineConfig({
	name: "@neon/env",
	// Bundled so `@neon-internals/*` — private, never published — is compiled into
	// `dist` instead of surviving as a bare specifier nobody can resolve from npm.
	bundle: true,
	clean: true,
	// `resolve` because the internals are reached through `node_modules`, which the
	// declaration bundler skips by default. `index.ts` re-exports types from
	// `@neon-internals/env-core/env`, and without this they land in the emitted `.d.ts`
	// as names with no definition.
	// `resolve` because the internals are reached through `node_modules`, which the
	// declaration bundler leaves external by default. `index.ts` re-exports types from
	// `@neon-internals/env-core/env`, and without this they land in the emitted `.d.ts`
	// as names with no definition.
	dts: { resolve: [/@neon-internals/] },
	// The two things this package exposes: the `.` export and the `neon-env` bin.
	// Everything else is reached through them, so nothing else needs to be an entry —
	// `exports` names no subpath, so no other emitted file was ever importable.
	entry: ["src/index.ts", "src/cli.ts"],
	format: "esm",
	// Entry declarations are emitted under the chunk name pattern, so with a hash
	// `dist/index.d.ts` becomes `dist/index-<hash>.d.ts` and `types` stops resolving.
	hash: false,
	outDir: "dist",
	treeshake: true,
	// Every bare specifier stays a runtime import except the private internals, which
	// are the whole reason this package bundles.
	external: (id) =>
		/^[@a-zA-Z]/.test(id) && !id.startsWith("@neon-internals/"),
});
