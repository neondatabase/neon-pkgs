import { OAUTH } from "@neon-internals/cli-core/credentials";
import { Analytics, type TrackParams } from "@segment/analytics-node";
import { getApiClient, isNeonApiError } from "./api.js";
import { type AuthContext, getAuthContext } from "./auth_context.js";
import { credentialsPath } from "./config.js";
import { isCurrentBranchProbe } from "./context.js";
import { storeFor } from "./credential_io.js";
import { getCliAgent, getGithubEnvVars, isCi } from "./env.js";
import { type ErrorCode, isUnexpectedError } from "./errors.js";
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
	if (authContext.storage === "keyring") {
		return { apiKey };
	}
	return {
		apiKey,
		credentialsPath: authContext.credentialsPath ?? defaultCredentialsPath,
	};
};

let client: Analytics | undefined;
let clientInitialized = false;
let errorEventContext: ErrorEventContext | undefined;

type AnalyticsEventArgs = {
	_: (string | number)[];
	output?: string;
	currentBranch?: boolean;
	prompt?: string;
	url?: string;
};

type AnalyticsEventProperties = {
	version: string;
	command: string;
	flags: {
		output: string | undefined;
	};
	ci: boolean;
	agent: ReturnType<typeof getCliAgent>;
	githubEnvVars: ReturnType<typeof getGithubEnvVars>;
};

type ErrorEventContext = {
	version: string;
	ci: boolean;
	agent: ReturnType<typeof getCliAgent>;
};

/** Lets tests send to a local collector; the CLI itself always uses track.neon.tech. */
export const useAnalyticsClientForTests = (analytics: Analytics) => {
	client = analytics;
	clientInitialized = true;
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

type Attribution = {
	userId: string;
	accountId?: string;
	authMethod?: string;
	authData?: string;
};

/**
 * The attribution of the current attempt. A 401 retry runs the middleware again and starts a
 * new one; events keep the attempt they were tracked in, even while its lookup is in flight.
 */
let attribution: Attribution = { userId: "" };

/**
 * Every event goes out through this chain so events tracked while the account lookup is in
 * flight are sent after "CLI Started", with the user id the lookup resolves, in call order.
 */
let queue: Promise<void> = Promise.resolve();
const lookups = new Set<AbortController>();

const enqueue = (
	send: (analytics: Analytics, attempt: Attribution) => void,
) => {
	const analytics = client;
	if (!analytics) {
		return;
	}
	const attempt = attribution;
	queue = queue.then(() => {
		// Telemetry must never fail a command.
		try {
			send(analytics, attempt);
		} catch (err) {
			log.debug("Could not queue a CLI analytics event: %s", err);
		}
	});
};

/**
 * Phase 2: Run after auth. Starts resolving the user id from credentials and returns; the
 * command does not wait for it. Identify and CLI Started go out once it settles.
 */
export const analyticsMiddleware = (args: {
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

	const attempt: Attribution = { userId: attribution.userId };
	attribution = attempt;

	const { apiKey: keyToQuery, credentialsPath: fileToRead } =
		telemetryCredential(
			getAuthContext(),
			args.apiKey,
			credentialsPath(args.configDir),
		);

	if (fileToRead !== undefined) {
		// Telemetry must never turn a damaged or unreadable credentials file into a failed command.
		try {
			const listing = storeFor(args.configDir).inspect({
				profile: getAuthContext()?.profile ?? "DEFAULT",
				storage: "file",
				path: fileToRead,
			});
			if (typeof listing.credentials?.user_id === "string") {
				attempt.userId = listing.credentials.user_id;
			} else {
				log.debug("No usable credentials at %s", fileToRead);
			}
		} catch (err) {
			log.debug("Could not read %s: %s", fileToRead, err);
		}
	} else if (getAuthContext()?.storage === "keyring") {
		try {
			const listing = storeFor(args.configDir).inspect({
				profile: getAuthContext()?.profile ?? "DEFAULT",
				storage: "keyring",
			});
			if (typeof listing.credentials?.user_id === "string") {
				attempt.userId = listing.credentials.user_id;
			}
		} catch (err) {
			log.debug("Could not read the OS keyring item: %s", err);
		}
	}

	const startedProperties = getAnalyticsEventProperties(args);
	const controller = new AbortController();
	lookups.add(controller);
	const lookup = (async () => {
		try {
			if (keyToQuery) {
				const apiClient = getApiClient({
					apiKey: keyToQuery,
					apiHost: args.apiHost,
				});
				const { data: authDetails } = await apiClient.getAuthDetails({
					signal: controller.signal,
				});
				attempt.accountId = authDetails.account_id;
				attempt.authMethod = authDetails.auth_method;
				attempt.authData = authDetails.auth_data;
				// Get user id if not org api key
				if (
					!attempt.userId &&
					authDetails.auth_method !== "api_key_org"
				) {
					const resp = await apiClient.getCurrentUserInfo({
						signal: controller.signal,
					});
					attempt.userId = resp.data.id;
				}
			} else {
				Object.assign(
					attempt,
					storedCredentialAttribution(attempt.userId),
				);
			}
		} catch (err) {
			log.debug("Failed to get user id from api", err);
		} finally {
			lookups.delete(controller);
		}
	})();

	queue = queue.then(() => lookup);
	enqueue((analytics, { userId }) => {
		analytics.identify({
			userId: analyticsUserId(userId),
		});
		analytics.track({
			userId: analyticsUserId(userId),
			event: "CLI Started",
			properties: startedProperties,
			context: {
				direct: true,
			},
		});
	});
};

/** How long closing waits for an unfinished account lookup before aborting it. */
const ATTRIBUTION_WAIT_MS = 1000;

let closing: Promise<void> | undefined;
const errorReports: Promise<void>[] = [];

/**
 * Send queued events, then close the client and flush. Later calls share the first close: the
 * psql launcher starts one while psql runs, and a second `closeAndFlush` would only make the SDK
 * warn about overlapping flushes. `timeout` bounds the whole close, lookup wait included.
 */
export const closeAnalytics = (opts?: { timeout?: number }): Promise<void> => {
	const analytics = client;
	if (!analytics) {
		return Promise.resolve();
	}
	if (!closing) {
		const started = Date.now();
		closing = (async () => {
			// With a caller budget, the lookup gets at most half of it so the flush keeps the rest.
			const wait = Math.min(
				ATTRIBUTION_WAIT_MS,
				(opts?.timeout ?? Infinity) / 2,
			);
			let timer: NodeJS.Timeout | undefined;
			const timedOut = await Promise.race([
				queue.then(() => false),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(true), wait);
				}),
			]);
			clearTimeout(timer);
			if (timedOut) {
				log.debug(
					"Account lookup unfinished; sending events without it",
				);
				for (const controller of lookups) {
					controller.abort();
				}
				await queue;
			}
			log.debug("Flushing CLI analytics");
			// `timeout` bounds how long we wait for in-flight events to flush so a
			// slow / unreachable track.neon.tech can't hang a short-lived command.
			// The SDK treats a 0 timeout as no limit, so never pass less than 1.
			const flush =
				opts?.timeout === undefined
					? undefined
					: {
							timeout: Math.max(
								1,
								opts.timeout - (Date.now() - started),
							),
						};
			await analytics.closeAndFlush(flush);
			await settleErrorReports(
				opts?.timeout === undefined
					? undefined
					: started + opts.timeout,
			);
			log.debug("Flushed CLI analytics");
		})();
	}
	return closing;
};

const settleErrorReports = async (deadline: number | undefined) => {
	const reports = Promise.all(errorReports);
	if (deadline === undefined) {
		await reports;
		return;
	}
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([
		reports,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
		}),
	]);
	clearTimeout(timer);
};

const getErrorAnalyticsEventContext = (
	_args: AnalyticsEventArgs,
): ErrorEventContext => ({
	version: pkg.version,
	ci: isCi(),
	agent: getCliAgent(process.env),
});

// `nak_live_…` is the credential token id (also AWS_ACCESS_KEY_ID). CLI Started
// joins argv, so `credentials reveal <tokenId>` would otherwise ship the key id.
const CREDENTIAL_TOKEN_ID = /\bnak_live_[0-9a-f]+\b/gi;

const redactCredentialTokenIds = (text: string): string =>
	text.replace(CREDENTIAL_TOKEN_ID, "nak_live_<redacted>");

export const getErrorAnalyticsEventProperties = (
	err: Error,
	errCode: ErrorCode,
	context?: ErrorEventContext,
) => {
	const apiError = isNeonApiError(err) ? err : undefined;
	const requestId = apiError?.headers?.["x-neon-ret-request-id"];

	return {
		...context,
		message: redactCredentialTokenIds(err.message),
		stack: err.stack ? redactCredentialTokenIds(err.stack) : err.stack,
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
	const properties = getErrorAnalyticsEventProperties(
		err,
		errCode,
		errorEventContext,
	);
	enqueue((analytics, { userId }) => {
		analytics.track({
			event: "CLI Error",
			userId: analyticsUserId(userId),
			properties,
		});
	});
	log.debug("Sent CLI error event: %s", errCode);
	if (errCode === "UNKNOWN_ERROR" && isUnexpectedError(err)) {
		const report = import("./error_reporting.js")
			.then(({ reportUnexpectedError }) =>
				reportUnexpectedError(err, redactCredentialTokenIds),
			)
			.catch((reportError: unknown) => {
				log.debug(
					"Could not report the error to Sentry: %s",
					reportError,
				);
			});
		errorReports.push(report);
		// The psql launcher starts closing before psql runs; a later close must still wait for this.
		if (closing) {
			closing = closing.then(() => report);
		}
	}
};

export const trackEvent = (
	event: string,
	properties: TrackParams["properties"],
) => {
	if (!client) {
		return;
	}
	enqueue((analytics, { userId }) => {
		analytics.track({
			event,
			userId: analyticsUserId(userId),
			properties,
		});
	});
	log.debug("Sent CLI event: %s", event);
};

/**
 * Tracks cli_command_success. The account fields come from the lookup, which may still be in
 * flight when the command finishes, so they are read when the event is sent.
 */
export const trackCommandSuccess = (
	args: Parameters<typeof commandSuccessProperties>[0],
) => {
	if (!client) {
		return;
	}
	const properties = commandSuccessProperties(args);
	enqueue((analytics, { userId, accountId, authMethod, authData }) => {
		analytics.track({
			event: "cli_command_success",
			userId: analyticsUserId(userId),
			properties: { ...properties, accountId, authMethod, authData },
		});
	});
};

/**
 * CLI Started runs before interactive pickers. Resolved template, agent-setup,
 * init path, and install scope ride on cli_command_success via this
 * process-local slot. Yargs never sees those choices.
 */
export type CommandAgentSetup =
	| "plugin"
	| "skills-mcp"
	| "skills"
	| "mcp"
	| "mixed"
	| "skip";
export type CommandInitKind = "empty-template" | "empty-skip" | "existing";
export type CommandInstallScope = "project" | "global";

export type CommandSuccessExtras = {
	template?: string;
	agent_setup?: CommandAgentSetup;
	init_kind?: CommandInitKind;
	scope?: CommandInstallScope;
};

let commandSuccessExtras: CommandSuccessExtras = {};

export const recordCommandSuccessExtras = (
	patch: CommandSuccessExtras,
): void => {
	commandSuccessExtras = { ...commandSuccessExtras, ...patch };
};

export const recordScaffoldedTemplate = (templateId: string): void => {
	recordCommandSuccessExtras({ template: templateId });
};

export const takeCommandSuccessExtras = (): CommandSuccessExtras => {
	const extras = commandSuccessExtras;
	commandSuccessExtras = {};
	return extras;
};

export const commandSuccessProperties = (
	args: AnalyticsEventArgs & {
		projectId?: string;
		branchId?: string;
		accountId?: string;
		authMethod?: string;
		authData?: string;
	},
) => ({
	...getAnalyticsEventProperties(args),
	projectId: args.projectId,
	branchId: args.branchId,
	accountId: args.accountId,
	authMethod: args.authMethod,
	authData: args.authData,
	...takeCommandSuccessExtras(),
});

const analyticsCommand = (args: AnalyticsEventArgs): string => {
	const command = args._.join(" ");
	const raw =
		args._[0] !== "ask" || typeof args.prompt !== "string"
			? command
			: `${command} ${args.prompt}`;
	return redactCredentialTokenIds(raw);
};

export const getAnalyticsEventProperties = (
	args: AnalyticsEventArgs,
): AnalyticsEventProperties => ({
	version: pkg.version,
	command: analyticsCommand(args),
	flags: {
		output: args.output,
	},
	ci: isCi(),
	agent: getCliAgent(process.env),
	githubEnvVars: getGithubEnvVars(process.env),
});
