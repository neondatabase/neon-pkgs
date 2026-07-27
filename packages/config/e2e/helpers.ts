import { configuredOrgId, requireApiKey } from "@neon/e2e-harness";
import type { NeonApi } from "../src/lib/neon-api.js";
import { createRealNeonApi } from "../src/lib/neon-api-real.js";

export type { ApiKeyScope } from "@neon/e2e-harness";
export {
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	sweepOrphans,
	uniqueProjectName,
} from "@neon/e2e-harness";

/** The same real NeonApi adapter the SDK uses internally — exercised end-to-end. */
export function makeRealApi(): NeonApi {
	return createRealNeonApi({ apiKey: requireApiKey() });
}

/**
 * Create a real Neon project via the NeonApi adapter directly. `pushConfig` no longer
 * provisions projects (callers are expected to run `neonctl link` first), so every e2e
 * test that needs a fresh project to push against goes through this helper instead.
 *
 * This deliberately does not use the harness's `createProject`: the adapter is part of
 * what these suites are testing.
 */
export async function bootstrapProject(
	api: NeonApi,
	args: { name: string; region: string },
): Promise<string> {
	const org = configuredOrgId();
	const created = await api.createProject({
		name: args.name,
		regionId: args.region,
		...(org ? { orgId: org } : {}),
	});
	return created.id;
}
