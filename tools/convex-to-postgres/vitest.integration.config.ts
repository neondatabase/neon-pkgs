import { defineConfig } from "vitest/config";

/**
 * Phase B integration suite. These tests spin up a real Postgres with
 * `@testcontainers/postgresql` (Docker required) and load real `convex export`
 * corpora, so they are kept out of the default `vitest.config.ts` run and the
 * recursive CI suite. Drop `*.integration.test.ts` files into `integration/`
 * and run them with `pnpm test:integration`.
 */
export default defineConfig({
	test: {
		// A fresh container plus corpus loading is slow; give the suite room so it
		// does not flake on a cold Docker pull.
		testTimeout: 120_000,
		hookTimeout: 180_000,
		include: ["integration/**/*.integration.test.ts"],
		// One Postgres container is booted in global setup and shared across the
		// files via provide/inject; run files sequentially so they share it
		// deterministically rather than opening a connection storm against it.
		globalSetup: ["integration/global-setup.ts"],
		fileParallelism: false,
	},
});
