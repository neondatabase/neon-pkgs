/**
 * Realtime, Neon Functions and their triggers, Object Storage, and the AI Gateway
 * run in a subset of regions. Outside them the Neon API answers 404 with a message
 * that does not say why, so the SDK names the project's region and the regions that
 * have the feature.
 */

import type { Client } from "../client/client/index.js";
import { getProject } from "../client/sdk.gen.js";
import { type NeonErrorUnion, NeonNotFoundError } from "./errors.js";

/**
 * From the Neon docs (each feature's availability section). `GET /regions` does not
 * report per-feature availability.
 */
export const PLATFORM_FEATURE_REGIONS: readonly string[] = [
	"aws-us-east-2",
	"aws-us-east-1",
	"aws-eu-central-1",
	"aws-ap-southeast-1",
];

export type PlatformFeature = { name: string; plural: boolean };

const UNAVAILABLE_FEATURE_MESSAGES: ReadonlyArray<[RegExp, PlatformFeature]> = [
	[
		/^Realtime is not available for this project$/i,
		{ name: "Realtime", plural: false },
	],
	[
		/^platform functions not available for this project$/i,
		{ name: "Neon Functions", plural: true },
	],
	[
		/^function triggers not available for this project$/i,
		{ name: "Function triggers", plural: true },
	],
	[
		/^platform branchable-storage is not available in this region$/i,
		{ name: "Object Storage", plural: false },
	],
	[
		/^ai gateway is not available in this region$/i,
		{ name: "The AI Gateway", plural: false },
	],
];

/** The feature a 404 "not available" error is about, if any. */
export function unavailableFeature(
	error: NeonErrorUnion,
): PlatformFeature | undefined {
	if (!(error instanceof NeonNotFoundError)) return undefined;
	return UNAVAILABLE_FEATURE_MESSAGES.find(([pattern]) =>
		pattern.test(error.message),
	)?.[1];
}

function listRegions(regions: readonly string[]): string {
	return `${regions.slice(0, -1).join(", ")}, and ${regions.at(-1)}`;
}

export function regionUnavailableMessage(
	feature: PlatformFeature,
	regionId: string,
): string {
	const [is, runs] = feature.plural ? ["are", "run"] : ["is", "runs"];
	return `${feature.name} ${is} not available for this project: it is in ${regionId}. ${feature.name} ${runs} in ${listRegions(PLATFORM_FEATURE_REGIONS)}. Create a project in one of those regions to use it.`;
}

function projectIdFromUrl(url: string | undefined): string | undefined {
	if (url === undefined || !URL.canParse(url)) return undefined;
	return /\/projects\/([^/?#]+)/.exec(new URL(url).pathname)?.[1];
}

/**
 * Rewrite a feature-unavailable 404 to name the project's region, read with one
 * `GET /projects/{id}` under the same signal. The original error stands when the
 * project is in a supported region (the 404 then has another cause), the request had
 * no project, or the region cannot be read.
 */
export async function explainRegionUnavailable(
	error: NeonErrorUnion,
	requestUrl: string | undefined,
	client: Client,
	signal: AbortSignal | undefined,
): Promise<NeonErrorUnion> {
	const feature = unavailableFeature(error);
	if (!feature || !(error instanceof NeonNotFoundError)) return error;
	const projectId = projectIdFromUrl(requestUrl);
	if (!projectId) return error;

	const { data } = await getProject({
		client,
		path: { project_id: projectId },
		throwOnError: false,
		signal,
	}).catch(() => ({ data: undefined }));
	const regionId = data?.project.region_id;
	if (!regionId || PLATFORM_FEATURE_REGIONS.includes(regionId)) return error;

	return new NeonNotFoundError(regionUnavailableMessage(feature, regionId), {
		status: error.status,
		code: error.code,
		requestId: error.requestId,
		response: error.response,
		body: error.body,
	});
}
