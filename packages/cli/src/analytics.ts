import { Analytics, type TrackParams } from "@segment/analytics-node";
import { inspectCredentials } from "./_shared/credentials.js";
import { getApiClient, isNeonApiError } from "./api.js";
import { getAuthContext } from "./auth_context.js";
import { credentialsPath } from "./config.js";
import { isCurrentBranchProbe } from "./context.js";
import { getGithubEnvVars, isCi } from "./env.js";
import type { ErrorCode } from "./errors.js";
import { log } from "./log.js";
import pkg from "./pkg.js";

const WRITE_KEY = "3SQXn5ejjXWLEJ8xU2PRYhAotLtTaeeV";

/**
 * Raw-argv fallback for the offline `--current-branch` probe. The init
 * middleware runs before validation, where the parsed `currentBranch` flag may
 * not be populated yet, so we also scan `process.argv` directly to be safe.
 */
const hasCurrentBranchArgv = (): boolean =>
	process.argv.includes("--current-branch");

let client: Analytics | undefined;
let clientInitialized = false;
/**
 * The account this invocation is attributed to, or `""` when nothing identified it.
 *
 * `""` is a reachable state rather than a placeholder — `ensureAuth` returns early for the
 * commands that run without credentials (`profile`, `dev`, `init`, …) — and it is not
 * nullish, so consumers must fall back with `||`. `?? "anonymous"` sends an empty identity.
 */
let userId = "";
let errorEventContext: ErrorEventContext | undefined;

type AnalyticsEventArgs = {
	_: (string | number)[];
	output?: string;
	currentBranch?: boolean;
};

type AnalyticsEventProperties = {
	version: string;
	command: string;
	flags: {
		output: string | undefined;
	};
	ci: boolean;
	githubEnvVars: ReturnType<typeof getGithubEnvVars>;
};

type ErrorEventContext = {
	version: string;
	ci: boolean;
};

/**
 * Phase 1: Run before validation so the Segment client exists if any
 * middleware (e.g. auth) fails. Enables sendError() in the fail handler.
 * Does not resolve user id or send CLI Started.
 */
export const initAnalyticsClientMiddleware = (
	args: AnalyticsEventArgs & { analytics: boolean },
) => {
	if (!args.analytics || clientInitialized) {
		return;
	}
	// The offline `--current-branch` probe must make zero network calls. This
	// middleware runs before validation, so guard on the raw argv too (in case
	// the parsed `currentBranch` flag isn't populated this early): never create
	// the Segment client, which keeps trackEvent/closeAnalytics no-ops downstream.
	if (isCurrentBranchProbe(args) || hasCurrentBranchArgv()) {
		return;
	}
	clientInitialized = true;
	errorEventContext = getErrorAnalyticsEventContext(args);
	client = new Analytics({
		writeKey: WRITE_KEY,
		host: "https://track.neon.tech",
	});
	log.debug("Initialized CLI analytics client");
	client.identify({
		userId: "anonymous",
	});
};

/**
 * Phase 2: Run after auth. Resolves user id from credentials,
 * identifies the user, and sends CLI Started.
 */
export const analyticsMiddleware = async (args: {
	analytics: boolean;
	apiKey?: string;
	apiHost?: string;
	configDir: string;
	_: (string | number)[];
	[key: string]: unknown;
}) => {
	if (!client || !args.analytics) {
		return;
	}
	if (isCurrentBranchProbe(args)) {
		return;
	}

	// Read the credentials this invocation actually authenticated with, which `ensureAuth`
	// recorded. Reading `DEFAULT`'s unconditionally attributed every `--profile`-selected
	// command to whichever account happened to be the default one.
	const authenticatedAs =
		getAuthContext()?.credentialsPath ?? credentialsPath(args.configDir);
	// Telemetry must never turn a damaged or unreadable credentials file into a failed command.
	try {
		const read = inspectCredentials(authenticatedAs);
		if (
			read.kind === "ok" &&
			typeof read.credentials.user_id === "string"
		) {
			userId = read.credentials.user_id;
		} else if (read.kind !== "ok") {
			log.debug("No usable credentials at %s", authenticatedAs);
		}
	} catch (err) {
		log.debug("Could not read %s: %s", authenticatedAs, err);
	}

	try {
		if (args.apiKey) {
			const apiClient = getApiClient({
				apiKey: args.apiKey,
				apiHost: args.apiHost,
			});

			// Populating api key details for analytics
			const authDetailsResponse = await apiClient.getAuthDetails();
			const authDetails = authDetailsResponse.data;
			args.accountId = authDetails.account_id;
			args.authMethod = authDetails.auth_method;
			args.authData = authDetails.auth_data;

			// Get user id if not org api key
			if (!userId && authDetails.auth_method !== "api_key_org") {
				const resp = await apiClient?.getCurrentUserInfo?.();
				userId = resp?.data?.id;
			}
		} else if (userId) {
			// Only when stored credentials identified someone. Reporting an empty
			// account under a method that was never used describes an
			// authentication that did not happen; reporting neither field is honest.
			args.accountId = userId;
			args.authMethod = "oauth";
		}
	} catch (err) {
		log.debug("Failed to get user id from api", err);
	}

	client.identify({
		userId: userId || "anonymous",
	});

	client.track({
		userId: userId || "anonymous",
		event: "CLI Started",
		properties: getAnalyticsEventProperties(args),
		context: {
			direct: true,
		},
	});
};

export const closeAnalytics = async (opts?: { timeout?: number }) => {
	if (client) {
		log.debug("Flushing CLI analytics");
		// `timeout` bounds how long we wait for in-flight events to flush so a
		// slow / unreachable track.neon.tech can't hang a short-lived command
		// (e.g. the psql launch path, which flushes here before process.exit).
		await client.closeAndFlush(opts);
		log.debug("Flushed CLI analytics");
	}
};

export const getErrorAnalyticsEventProperties = (
	err: Error,
	errCode: ErrorCode,
	context?: ErrorEventContext,
) => {
	const apiError = isNeonApiError(err) ? err : undefined;
	const requestId = apiError?.headers?.["x-neon-ret-request-id"];

	return {
		...context,
		message: err.message,
		stack: err.stack,
		errCode,
		statusCode: apiError?.status,
		requestId,
	};
};

export const sendError = (err: Error, errCode: ErrorCode) => {
	if (!client) {
		return;
	}
	const apiError = isNeonApiError(err) ? err : undefined;
	const requestId = apiError?.headers?.["x-neon-ret-request-id"];
	if (requestId) {
		log.debug("Failed request ID: %s", requestId);
	}
	client.track({
		event: "CLI Error",
		userId: userId || "anonymous",
		properties: getErrorAnalyticsEventProperties(
			err,
			errCode,
			errorEventContext,
		),
	});
	log.debug("Sent CLI error event: %s", errCode);
};

export const trackEvent = (
	event: string,
	properties: TrackParams["properties"],
) => {
	if (!client) {
		return;
	}
	client.track({
		event,
		userId: userId || "anonymous",
		properties,
	});
	log.debug("Sent CLI event: %s", event);
};

const getErrorAnalyticsEventContext = (
	_args: AnalyticsEventArgs,
): ErrorEventContext => ({
	version: pkg.version,
	ci: isCi(),
});

export const getAnalyticsEventProperties = (
	args: AnalyticsEventArgs,
): AnalyticsEventProperties => ({
	version: pkg.version,
	command: args._.join(" "),
	flags: {
		output: args.output,
	},
	ci: isCi(),
	githubEnvVars: getGithubEnvVars(process.env),
});
