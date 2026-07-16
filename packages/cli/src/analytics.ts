import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Analytics, type TrackParams } from "@segment/analytics-node";
import { getApiClient, isNeonApiError } from "./api.js";
import { CREDENTIALS_FILE } from "./config.js";
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

const KNOWN_COMMAND_ROOTS = new Set([
	"api",
	"auth",
	"bootstrap",
	"branches",
	"bucket",
	"checkout",
	"config",
	"connection-string",
	"cs",
	"data-api",
	"databases",
	"deploy",
	"dev",
	"diff",
	"env",
	"functions",
	"init",
	"ip-allow",
	"link",
	"login",
	"me",
	"neon-auth",
	"operations",
	"orgs",
	"projects",
	"psql",
	"roles",
	"set-context",
	"status",
	"users",
	"vpc-endpoints",
]);

const OUTPUT_FORMATS = new Set(["json", "table", "yaml"]);

let client: Analytics | undefined;
let clientInitialized = false;
let userId = "";
let errorEventContext: AnalyticsEventProperties | undefined;

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

type AnalyticsErrorKind =
	| "ambiguous_target"
	| "authentication_failed"
	| "authentication_timeout"
	| "invalid_request"
	| "missing_argument"
	| "network_failure"
	| "resource_conflict"
	| "resource_not_found"
	| "request_timeout"
	| "unknown_command"
	| "unknown_error";

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
	errorEventContext = getAnalyticsEventProperties(args);
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

	try {
		const credentialsPath = join(args.configDir, CREDENTIALS_FILE);
		const credentials = readFileSync(credentialsPath, {
			encoding: "utf-8",
		});
		userId = JSON.parse(credentials).user_id;
	} catch (err) {
		log.debug("Failed to read credentials file", err);
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
		} else {
			args.accountId = userId;
			args.authMethod = "oauth";
		}
	} catch (err) {
		log.debug("Failed to get user id from api", err);
	}

	client.identify({
		userId: userId?.toString() ?? "anonymous",
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
	context?: AnalyticsEventProperties,
) => {
	const apiError = isNeonApiError(err) ? err : undefined;
	const requestId = apiError?.headers?.["x-neon-ret-request-id"];

	return {
		...context,
		errCode,
		reason: getAnalyticsErrorKind(err.message, errCode, apiError?.status),
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

export const getAnalyticsCommand = (
	commandParts: (string | number)[],
): string => {
	const root = commandParts[0];
	return typeof root === "string" && KNOWN_COMMAND_ROOTS.has(root)
		? root
		: "unknown";
};

export const getAnalyticsOutputFormat = (
	output: string | undefined,
): string | undefined =>
	output && OUTPUT_FORMATS.has(output) ? output : undefined;

export const getAnalyticsErrorKind = (
	message: string,
	errCode: ErrorCode,
	statusCode: number | undefined,
): AnalyticsErrorKind => {
	if (/^Unknown commands?:/i.test(message) || errCode === "UNKNOWN_COMMAND") {
		return "unknown_command";
	}
	if (
		/^Missing required argument:/i.test(message) ||
		errCode === "MISSING_ARGUMENT"
	) {
		return "missing_argument";
	}
	if (/Authentication timed out/i.test(message)) {
		return "authentication_timeout";
	}
	if (
		errCode === "AUTH_FAILED" ||
		errCode === "AUTH_BROWSER_FAILED" ||
		statusCode === 401
	) {
		return "authentication_failed";
	}
	if (errCode === "NETWORK_ERROR") {
		return "network_failure";
	}
	if (errCode === "REQUEST_TIMEOUT" || statusCode === 408) {
		return "request_timeout";
	}
	if (
		statusCode === 404 ||
		/(?:branch|project|resource) .+ not found/i.test(message)
	) {
		return "resource_not_found";
	}
	if (statusCode === 409 || /already exists|limit exceeded/i.test(message)) {
		return "resource_conflict";
	}
	if (statusCode === 400 || statusCode === 422) {
		return "invalid_request";
	}
	if (/^Multiple (?:projects|roles) found/i.test(message)) {
		return "ambiguous_target";
	}
	return "unknown_error";
};

export const getAnalyticsEventProperties = (
	args: AnalyticsEventArgs,
): AnalyticsEventProperties => ({
	version: pkg.version,
	command: getAnalyticsCommand(args._),
	flags: {
		output: getAnalyticsOutputFormat(args.output),
	},
	ci: isCi(),
	githubEnvVars: getGithubEnvVars(process.env),
});
