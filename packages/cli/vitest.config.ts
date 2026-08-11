import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			// Resolve the private internals to their TypeScript *source* rather than their built
			// `dist/`. Their `exports` point at `dist/`, so without this the specs that cover them
			// — `credentials`, `paths`, `profiles`, `auth_selection` — run against the last build
			// and pass against code that no longer exists. Aliasing to source also puts
			// `internals/*/src` in the watch graph, so editing it re-runs those specs.
			//
			// This is read-only, so unlike having the consumers rebuild the internals it cannot
			// race with a recursive `pnpm build`. `packages/env/vitest.config.ts` does the same
			// for `@neon/config`, for the same reason.
			{
				find: /^@neon-internals\/(cli-core|env-core)\/(.+)$/,
				replacement: resolve(here, "../../internals/$1/src/$2.ts"),
			},
		],
	},
	test: {
		setupFiles: ["./test-setup.ts"],
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"tests/psql-conformance/**",
			// Live Neon suite — needs credentials and a throwaway org.
			// Run it with `pnpm --filter neon test:e2e`.
			"e2e/**",
		],
	},
});
