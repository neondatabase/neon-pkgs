// Loaded by vitest.e2e.config.ts `setupFiles`; not imported statically.
// fallow-ignore-file unused-file
import { beforeAll } from "vitest";
import { detectApiKeyScope, sweepOrphans } from "./helpers.js";

/**
 * Suite-level setup. Runs once before any e2e test:
 * 1. Probes the configured API key to detect its scope. We do this here so a misconfigured
 *    environment fails fast with a clear message rather than surfacing as cryptic 403s
 *    inside individual tests.
 * 2. When the key is org/user-scoped, sweep any orphaned `neon-ts-e2e-*` projects
 *    left over from a previous run.
 */
beforeAll(async () => {
	const scope = await detectApiKeyScope();
	if (scope.kind === "org-or-user") {
		const { swept } = await sweepOrphans();
		if (swept.length > 0) {
			console.warn(
				`[e2e setup] swept ${swept.length} orphaned project(s) from a previous run.`,
			);
		}
	}
});
