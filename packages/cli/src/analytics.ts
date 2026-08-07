import { Analytics, type TrackParams } from "@segment/analytics-node";
import { inspectCredentials, OAUTH } from "./_shared/credentials.js";
import { getApiClient, isNeonApiError } from "./api.js";
import { type AuthContext, getAuthContext } from "./auth_context.js";
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

const ANONYMOUS = "anonymous";

/**
 * Who to attribute an event to, given whatever identified this invocation.
 *
 * Nothing is guaranteed to have identified it: a command can run with no credentials at all,
 * leaving the id empty. Segment accepts an empty `userId` and forwards it as-is rather than
 * rejecting it, so the substitution has to happen here. `""` is falsy but not nullish, which
 * is why the fallback has to be `||`.
 *
 * Exported for tests.
 */
export const analyticsUserId = (userId: string | undefined): string =>
	userId || ANONYMOUS;

/**
 * The account fields of `cli_command_success`, produced here and read in `index.ts`.
 */
export type EventAttribution = {
	accountId?: string;
	authMethod?: string;
};

/**
 * The account an invocation that presented no API key may claim, which is nothing at all
 * unless stored credentials named a user.
 *
 * Both fields are omitted together. An empty account reported under a named method describes
 * an authentication that did not happen, which is worse than reporting neither.
 *
 * Exported for tests.
 */
export const storedCredentialAttribution = (
	storedUserId: string | undefined,
): EventAttribution =>
	storedUserId ? { accountId: storedUserId, authMethod: OAUTH } : {};

/** A key to ask the API about, a file to read an id out of, or both. */
export type TelemetryCredential = {
	apiKey?: string;
	credentialsPath?: string;
};

/**
 * Which credential telemetry may describe this invocation with.
 *
 * `ensureAuth` records a context only when it selected a credential for this invocation, so a
 * missing context means the global auth middleware selected nothing before this ran. A key
 * sitting in `args.apiKey` is then not the credential the middleware chose — `neon profile list`
 * never used it — and must not be queried on its behalf, which would attribute the run to an
 * account it never authenticated as and add a telemetry-only API call. The local default is the
 * guess.
 *
 * The boundary is deliberately the credential the middleware selected, not every key a handler
 * may go on to use. Several `profile` subcommands authenticate inside their own handlers —
 * `create --api-key` verifies the key it is about to store, `rotate-key` mints and revokes — and
 * those runs are attributed to the local default rather than to the account the handler talked
 * to. Attributing them to that key puts an `identify` for the signed-in user beside an
 * `accountId` for a different account.
 *
 * A selected key records no file, because it authenticates as its own account rather than out
 * of one. Reading `DEFAULT` for it would identify the run as whoever is signed in locally, and
 * that borrowed id would suppress the API lookup that names the key's real owner.
 *
 * Exported for tests.
 */
export const telemetryCredential = (
	authContext: AuthContext | null,
	apiKey: string | undefined,
	defaultCredentialsPath: string,
): TelemetryCredential => {
	if (authContext === null) {
		return { credentialsPath: defaultCredentialsPath };
	}
	if (authContext.source === "api-key") {
		return { apiKey };
	}
	return {
		apiKey,
		credentialsPath: authContext.credentialsPath ?? defaultCredentialsPath,
	};
};

let client: Analytics | undefined;
let clientInitialized = false;
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
		userId: ANONYMOUS,
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

	const { apiKey: keyToQuery, credentialsPath: fileToRead } =
		telemetryCredential(
			getAuthContext(),
			args.apiKey,
			credentialsPath(args.configDir),
		);

	if (fileToRead !== undefined) {
		// Telemetry must never turn a damaged or unreadable credentials file into a failed command.
		try {
			const read = inspectCredentials(fileToRead);
			if (
				read.kind === "ok" &&
				typeof read.credentials.user_id === "string"
			) {
				userId = read.credentials.user_id;
			} else if (read.kind !== "ok") {
				log.debug("No usable credentials at %s", fileToRead);
			}
		} catch (err) {
			log.debug("Could not read %s: %s", fileToRead, err);
		}
	}

	try {
		if (keyToQuery) {
			const apiClient = getApiClient({
				apiKey: keyToQuery,
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
		} else {
			const { accountId, authMethod } =
				storedCredentialAttribution(userId);
			args.accountId = accountId;
			args.authMethod = authMethod;
		}
	} catch (err) {
		log.debug("Failed to get user id from api", err);
	}

	client.identify({
		userId: analyticsUserId(userId),
	});

	client.track({
		userId: analyticsUserId(userId),
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
		userId: analyticsUserId(userId),
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
		userId: analyticsUserId(userId),
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
