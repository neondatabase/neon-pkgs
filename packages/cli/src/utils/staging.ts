import { Parser } from "yargs/helpers";

/**
 * Staging-only features ship in a release before their API reaches production. The CLI
 * exposes them only when the API host it sends requests to (`--api-host`, else
 * `NEON_API_HOST`) is Neon's staging console; with production or no host set, they do not
 * exist.
 */
export const STAGING_API_HOST = "https://console-stage.neon.build/api/v2";

/** `NEON_STAGING_API_HOST` lets the CLI's tests treat their local mock API as staging. */
const stagingHostname = () =>
	new URL(process.env.NEON_STAGING_API_HOST ?? STAGING_API_HOST).hostname;

export const isStagingApiHost = (apiHost: string | undefined): boolean =>
	apiHost !== undefined &&
	URL.canParse(apiHost) &&
	new URL(apiHost).hostname === stagingHostname();

export const stagingFeaturesEnabled = (apiHost?: string): boolean =>
	isStagingApiHost(apiHost ?? process.env.NEON_API_HOST);

/** The same decision before yargs runs, for choosing which commands to register. */
export const stagingFeaturesEnabledForArgv = (args: readonly string[]) => {
	const { argv } = Parser.detailed([...args], {
		string: ["api-host"],
		configuration: {
			"populate--": true,
			"parse-positional-numbers": false,
		},
	});
	const flag = argv["api-host"];
	return stagingFeaturesEnabled(typeof flag === "string" ? flag : undefined);
};

export const STAGING_ONLY_MESSAGE = `is staging-only. Point the CLI at staging with NEON_API_HOST=${STAGING_API_HOST} or --api-host.`;
