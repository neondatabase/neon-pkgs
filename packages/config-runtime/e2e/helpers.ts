import { createRealNeonApi, type NeonApi } from "@neon/config";
import { configuredOrgId, requireApiKey } from "@neon/e2e-harness";

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
 * Create a real Neon project via the NeonApi adapter directly, so the suite has a fresh
 * project to push policy against.
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
