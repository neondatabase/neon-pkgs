import { defineConfig } from "tsdown";

export default defineConfig({
	name: "neon",
	bundle: false,
	clean: true,
	// `neon` publishes no declarations: `packages/cli/tsconfig.json` never set
	// `declaration`, so `tsc` emitted none and `exports["."]` has no `types`.
	dts: false,
	// Every non-test source file, so each one keeps emitting to its own path under
	// `dist/` — `neon` exports a `./dist/*` wildcard, and `src/_shared` is synced-in
	// source that has to compile as this package's own.
	entry: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.spec.ts"],
	format: "esm",
	outDir: "dist",
	treeshake: true,
	// Every bare specifier stays a runtime import, which is what `tsc` emitted. tsdown
	// externalizes declared runtime dependencies only, so without this `src/test_utils/*`
	// — which imports vitest, express and emocks — drags those devDependencies and their
	// transitive graph into `dist/node_modules/`.
	external: (id) => /^[@a-zA-Z]/.test(id),
});
