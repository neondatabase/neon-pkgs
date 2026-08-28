import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
	analyticsMiddleware,
	closeAnalytics,
	getAnalyticsEventProperties,
	initAnalyticsClientMiddleware,
	sendError,
	trackEvent,
} from "./analytics.js";
import { isNeonApiError, messageFromBody, type NeonApiClient } from "./api.js";
import { defaultClientID } from "./auth.js";
import {
	authFailureMessage,
	credentialsToClearOn401,
	getAuthContext,
} from "./auth_context.js";
import { deleteCredentialsAt, ensureAuth } from "./commands/auth.js";
import commands from "./commands/index.js";
import { defaultDir, ensureConfigDir } from "./config.js";
import { currentContextFile, enrichFromContext } from "./context.js";
import {
	isNetworkError,
	matchErrorCode,
	NETWORK_ERROR_MESSAGE,
} from "./errors.js";
import { showHelp } from "./help.js";
import { log } from "./log.js";
import pkg from "./pkg.js";
import { getCliName } from "./utils/cli_name.js";
import { fillInArgs, resolveApiKeyFromEnv } from "./utils/middlewares.js";

const NO_SUBCOMMANDS_VERBS = [
	// `api <path>` has a handler but no subcommands (like `status`), so the
	// help-fallback middleware must not intercept a bare `neon api /projects`.
	"api",

	// aliases
	"auth",
	"login",
	"me",

	// aliases
	"cs",
	"connection-string",

	"psql",

	"set-context",

	"checkout",

	"link",

	"open",

	"init",

	"mcp",

	"plugins",

	"skills",

	"dev",

	"deploy",

	// `diff <compare-branch>` has a handler but no subcommands (like `status`),
	// so the help-fallback middleware must not intercept a bare `neon diff main`.
	"diff",

	"bootstrap",

	// alias of `config status`
	"status",
];

let builder = yargs(hideBin(process.argv));
builder = builder
	.scriptName(pkg.name)
	.locale("en")
	.usage("$0 <command> [options]")
	.parserConfiguration({
		"populate--": true,
	})
	.help()
	.option("output", {
		alias: "o",
		group: "Global options:",
		describe: "Set output format",
		type: "string",
		choices: ["json", "yaml", "table"],
		default: "table",
	})
	.option("api-host", {
		describe: "The API host",
		hidden: true,
		default:
			process.env.NEON_API_HOST ?? "https://console.neon.tech/api/v2",
	})
	// Setup config directory
	.option("config-dir", {
		describe: "Path to config directory",
		group: "Global options:",
		type: "string",
		default: defaultDir,
	})
	.option("profile", {
		describe:
			"Named credentials to use, from profiles.json (default: NEON_PROFILE, else DEFAULT)",
		group: "Global options:",
		type: "string",
	})
	.option("force-auth", {
		describe: "Force authentication",
		type: "boolean",
		hidden: true,
		default: false,
	})
	.middleware(ensureConfigDir)
	.options({
		"oauth-host": {
			description: "URL to Neon OAuth host",
			hidden: true,
			default: process.env.NEON_OAUTH_HOST ?? "https://oauth2.neon.tech",
		},
		"client-id": {
			description: "OAuth client id",
			hidden: true,
			type: "string",
			default: defaultClientID,
		},
		"api-key": {
			describe: "API key",
			group: "Global options:",
			type: "string",
			// Take the next token as the value even when it looks like an option, so
			// `--api-key -` binds the dash rather than being read as a command of its own.
			// `profile create` gives `-` its meaning; everywhere else it is just a value.
			nargs: 1,
			// The default must never be the value of NEON_API_KEY: yargs renders an
			// option's default into every help screen, so that printed the user's key
			// verbatim on `neon --help`. `resolveApiKeyFromEnv` reads the env var
			// instead, and `defaultDescription` names it in help without its value.
			default: "",
			defaultDescription: "NEON_API_KEY",
		},
		apiClient: {
			hidden: true,
			coerce: (v) => v as NeonApiClient,
			default: null as unknown as NeonApiClient,
		},
		"context-file": {
			describe: "Context file",
			type: "string",
			default: currentContextFile,
		},
		color: {
			group: "Global options:",
			describe: "Colorize the output. Example: --no-color, --color false",
			type: "boolean",
			default: true,
		},
		analytics: {
			describe:
				"Manage analytics. Example: --no-analytics, --analytics false",
			group: "Global options:",
			type: "boolean",
			default: true,
		},
	})
	.middleware((args) => {
		fillInArgs(args);
	}, true)
	.middleware(resolveApiKeyFromEnv, true)
	.middleware(initAnalyticsClientMiddleware, true)
	.help(false)
	.group("help", "Global options:")
	.option("help", {
		describe: "Show help",
		type: "boolean",
		default: false,
	})
	.alias("help", "h")
	.middleware(async (args) => {
		if (
			args.help ||
			(args._.length === 1 &&
				!NO_SUBCOMMANDS_VERBS.includes(args._[0] as string))
		) {
			await showHelp(builder);
		}
	})
	.middleware(ensureAuth)
	.middleware(enrichFromContext as any)
	.middleware(analyticsMiddleware)
	.command(commands as any)
	.strictCommands()
	.version(pkg.version)
	.group("version", "Global options:")
	.alias("version", "v")
	.completion()
	.scriptName(getCliName())
	.epilog(
		"For more information, visit https://neon.com/docs/reference/neon-cli",
	)
	.wrap(null)
	.fail(false);

async function handleError(msg: string, err: unknown): Promise<boolean> {
	if (process.argv.some((arg) => arg === "--help" || arg === "-h")) {
		await showHelp(builder);
		process.exit(0);
	}

	// Log stack trace if available
	if (err instanceof Error && err.stack) {
		log.debug("Stack: %s", err.stack);
	}

	// A connection-level failure (no response ever reached us) reads as a cryptic
	// `fetch failed` from the @neon/sdk / global `fetch` path. Detect it first and
	// swap in one clear "check your connection" hint. We deliberately do not retry
	// here: re-running the whole command could re-trigger a non-idempotent step
	// (e.g. project create), so retries belong at the request layer.
	if (isNetworkError(err)) {
		log.error(NETWORK_ERROR_MESSAGE);
		const error =
			err instanceof Error ? err : new Error(NETWORK_ERROR_MESSAGE);
		sendError(error, "NETWORK_ERROR");
		return false;
	}

	if (isNeonApiError(err)) {
		if (err.code === "ECONNABORTED") {
			log.error("Request timed out");
			sendError(err, "REQUEST_TIMEOUT");
			return false;
		} else if (err.status === 401) {
			sendError(err, "AUTH_FAILED");
			const context = getAuthContext();
			const staleCredentials = credentialsToClearOn401(context);
			// The request was authorized with a key rather than a refreshable token — one the
			// user supplied, or one stored in a profile. Either way there is nothing to clear
			// and nothing to retry, since the same key would just be rejected again. Deleting
			// a profile's key would destroy the only copy of a credential that cannot be
			// refreshed, so the message says what to re-run instead.
			if (staleCredentials === null) {
				log.error(authFailureMessage(context));
				return false;
			}
			log.info("Authentication failed, deleting credentials...");
			try {
				if (context === null) return false;
				deleteCredentialsAt(staleCredentials, context.configDir);
				return true; // Allow retry for auth failures
			} catch (deleteErr) {
				log.debug(
					"Failed to delete credentials: %s",
					deleteErr instanceof Error
						? deleteErr.message
						: "unknown error",
				);
				return false;
			}
		} else {
			const serverMessage = messageFromBody(err.data);
			if (serverMessage) {
				log.error(serverMessage);
			}
			log.debug(
				"status: %d %s | path: %s",
				err.status,
				err.statusText,
				err.requestPath,
			);
			sendError(err, "API_ERROR");
			return false;
		}
	} else {
		const error =
			err instanceof Error ? err : new Error(msg || "Unknown error");
		const code = matchErrorCode(error.message);
		sendError(error, code);
		// The completion summary already reported this failure.
		if (code !== "NEON_INIT_FAILED") {
			log.error(error.message);
		}
		return false;
	}
}

void (async () => {
	// Main loop with max 2 attempts (initial + 1 retry):
	let attempts = 0;
	const MAX_ATTEMPTS = 2;

	while (attempts < MAX_ATTEMPTS) {
		try {
			const args = await builder.argv;

			// Send analytics for a successful attempt
			trackEvent("cli_command_success", {
				...getAnalyticsEventProperties(args),
				projectId: args.projectId,
				branchId: args.branchId,
				accountId: args.accountId,
				authMethod: args.authMethod,
				authData: args.authData,
			});
			if (args._.length === 0 || args.help) {
				await showHelp(builder);
				process.exit(0);
			}

			await closeAnalytics();
			break;
		} catch (err) {
			attempts++;
			const shouldRetry = await handleError("", err);
			if (!shouldRetry || attempts >= MAX_ATTEMPTS) {
				await closeAnalytics();
				process.exit(1);
			}
			// If shouldRetry is true and we haven't hit max attempts, loop continues
		}
	}
})();
