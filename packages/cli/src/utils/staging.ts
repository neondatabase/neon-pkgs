import { hideBin, Parser } from "yargs/helpers";

/**
 * Staging-only features ship in a release before their API reaches production. The CLI
 * exposes them only when the API host it sends requests to (`--api-host`, else
 * `NEON_API_HOST`) is Neon's staging console; with production or no host set, they are
 * hidden from help and fail with a "coming soon" message.
 */
export const STAGING_API_HOST = "https://console-stage.neon.build/api/v2";

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

/** A hard stop: callers that degrade other failures to warnings let this one through. */
export class StagingOnlyError extends Error {
	override readonly name = "StagingOnlyError";
}
