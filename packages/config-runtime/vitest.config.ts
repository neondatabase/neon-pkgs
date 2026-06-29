import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the sibling `@neon/config` workspace package to its TypeScript *source*
// rather than its built `dist/`. By default `workspace:*` + the package's `exports` point at
// `dist/`, so these cross-package tests silently run against a **stale** build whenever
// `config/src` is ahead of `config/dist` — e.g. local edits between `pnpm build`s, or CI's
// `test` job, which installs but never builds. That made `push-config.test.ts` flaky (a
// pre-#184 `dist` reports a re-deploy as `create` instead of `update`). Pointing at `src`
// makes the suite deterministic and always reflect current source.
const configSrc = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../config/src",
);

export default defineConfig({
	resolve: {
		alias: [
			// More specific subpath first; the bare-package alias is anchored so it
			// matches `@neon/config` exactly and never the `/v1` subpath.
			{
				find: "@neon/config/v1",
				replacement: resolve(configSrc, "v1.ts"),
			},
			{
				find: /^@neondatabase\/config$/,
				replacement: resolve(configSrc, "index.ts"),
			},
		],
	},
	test: {
		clearMocks: true,
		mockReset: true,
		unstubEnvs: true,
		coverage: {
			all: true,
			include: ["src"],
			exclude: ["src/**/*.test.ts"],
			reporter: ["html", "lcov"],
		},
		// Skip e2e tests (which talk to the real Neon API) in the standard suite — they
		// run via `pnpm test:e2e` against `vitest.e2e.config.ts`.
		exclude: ["lib", "node_modules", "dist", "**/*.e2e.test.ts", "e2e/**"],
		setupFiles: ["console-fail-test/setup"],
	},
});
