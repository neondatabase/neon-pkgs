import type { Config } from "@neon/config-runtime";
import { hideBin, Parser } from "yargs/helpers";

/**
 * Staging-only features ship in a release before their API reaches production. The CLI
 * exposes them only when the API host it sends requests to (`--api-host`, else
 * `NEON_API_HOST`) is Neon's staging console; with production or no host set, they are
 * hidden from help and fail with a "coming soon" message.
 */
export const STAGING_API_HOST = "https://console-stage.neon.build/api/v2";

export const REALTIME_COMING_SOON = `Neon Realtime is coming soon! For now it only works on Neon's staging API: set NEON_API_HOST=${STAGING_API_HOST} or pass --api-host.`;

/** `NEON_STAGING_API_HOST` lets the CLI's tests treat their local mock API as staging. */
const stagingHostname = () =>
	new URL(process.env.NEON_STAGING_API_HOST ?? STAGING_API_HOST).hostname;

export const isStagingApiHost = (apiHost: string | undefined): boolean =>
	apiHost !== undefined &&
	URL.canParse(apiHost) &&
	new URL(apiHost).hostname === stagingHostname();

/** The API host this process was invoked with, read before or without yargs. */
export const stagingFeaturesEnabledForArgv = (
	args: readonly string[] = hideBin(process.argv),
): boolean => {
	const { argv } = Parser.detailed([...args], {
		string: ["api-host"],
		alias: { "api-host": ["apiHost"] },
		configuration: {
			"populate--": true,
			"parse-positional-numbers": false,
		},
	});
	const flag = argv["api-host"];
	return isStagingApiHost(
		typeof flag === "string" ? flag : process.env.NEON_API_HOST,
	);
};

/** `apiHost` is a command's resolved host; without one, the host this process was invoked with. */
export const stagingFeaturesEnabled = (apiHost?: string): boolean =>
	apiHost === undefined
		? stagingFeaturesEnabledForArgv()
		: isStagingApiHost(apiHost);

/** Service names to list in help: Realtime only on staging. */
export const listedServices = <T extends string>(services: readonly T[]) =>
	stagingFeaturesEnabledForArgv()
		? services
		: services.filter((service) => service !== "realtime");

/** A hard stop: callers that degrade other failures to warnings let this one through. */
export class StagingOnlyError extends Error {
	override readonly name = "StagingOnlyError";
}

export const assertRealtimeAvailable = (apiHost?: string): void => {
	if (!stagingFeaturesEnabled(apiHost)) {
		throw new StagingOnlyError(REALTIME_COMING_SOON);
	}
};

/**
 * A `neon.ts` with any `preview.realtime` value reads the Realtime API, which production
 * does not serve. `false` reads it too, to disable Realtime on the branch.
 */
export const assertPolicyAvailable = (config: Config, apiHost?: string) => {
	if (config.preview?.realtime !== undefined) {
		assertRealtimeAvailable(apiHost);
	}
};
