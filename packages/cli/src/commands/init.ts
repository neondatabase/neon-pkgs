import type yargs from "yargs";
import { credentialInputs } from "../_shared/auth_selection.js";
import { closeAnalytics, sendError } from "../analytics.js";
import { detectAgent } from "../init/detect_agent.js";
import { enrichResponse } from "../init/enrich_output.js";
import { interactiveInit } from "../init/interactive.js";
import { orchestrate } from "../init/orchestrate.js";
import { routeDataStep } from "../init/route_command.js";
import { STDOUT_FD, writeAllSync } from "../utils/write_sync.js";

export const command = "init";
export const describe =
	"Initialize a project with Neon using your AI coding assistant";
export const builder = (yargs: yargs.Argv) =>
	yargs
		.option("context-file", {
			hidden: true,
		})
		.option("agent", {
			alias: "a",
			type: "boolean",
			default: false,
			describe: "Enable agent/JSON mode (agent type is auto-detected).",
		})
		.option("data", {
			type: "string",
			describe:
				'JSON object with a "step" field to route to a specific phase and phase-specific options.',
		})
		.option("skip-migrations", {
			type: "boolean",
			default: false,
			describe: "Skip the migrations phase.",
		})
		.option("preview", {
			type: "boolean",
			default: false,
			describe:
				"Enable preview features (e.g. project bootstrapping from templates).",
		})
		.strict(false);

/**
 * The agent-facing half of `neon init` speaks JSON, and it speaks it on **stdout**:
 * one object, no prefix, nothing else. `log.info` would prefix every line with
 * `INFO: ` and send it to stderr, which is right for a diagnostic and wrong for the
 * payload an agent is expected to parse.
 */
const writeAgentResponse = (result: unknown) => {
	writeAllSync(
		STDOUT_FD,
		`${JSON.stringify(enrichResponse(result), null, 2)}\n`,
	);
};

/**
 * A failure has to arrive in the shape the caller asked for. An agent parses stdout and
 * has no branch for "empty stdout, exit 1" — it cannot tell a broken credentials file
 * from a phase that legitimately produced nothing — so the error goes out as JSON too.
 */
const writeAgentFailure = (error: Error) => {
	writeAllSync(
		STDOUT_FD,
		`${JSON.stringify({ success: false, error: error.message }, null, 2)}\n`,
	);
};

export const handler = async (argv: {
	agent?: boolean;
	data?: string;
	skipMigrations?: boolean;
	preview?: boolean;
	profile?: string;
}) => {
	// Auto-detect agent from environment. When --agent is explicitly passed,
	// always detect (the user asked for agent mode). Otherwise, require
	// non-TTY stdin to distinguish agent from human in terminal.
	//
	// Resolved before anything can fail, so that every failure below — including the
	// profile refusal — is reported in the shape this caller can read.
	const agent =
		(argv.agent || !process.stdin.isTTY ? detectAgent() : null) ||
		undefined;
	const isAgentMode = argv.agent || agent !== undefined;

	try {
		// The init flow reads the default credentials directly and re-invokes the CLI as a
		// subprocess. It has no way to be told which profile to use, so honouring a selection
		// here is not possible yet — and silently running as the default account would be
		// worse than refusing, because naming an account is the entire job of the thing being
		// ignored.
		//
		// `NEON_PROFILE` counts just as much as the flag. Checking only the flag left the case
		// that is easier to hit by accident: a profile exported once into a shell then
		// silently disregarded by every `neon init` run in it.
		const selectedProfile =
			argv.profile?.trim() || credentialInputs().profileEnv.trim();
		if (selectedProfile) {
			const how = argv.profile?.trim()
				? "--profile was passed, so"
				: "NEON_PROFILE is set, so";
			throw new Error(
				`${how} \`neon init\` would run as the default account instead of "${selectedProfile}", and it does not support profile selection yet. Run it without one, or set the project up with \`neon --profile ${selectedProfile} link\`.`,
			);
		}

		// --data with a "step" field routes to the appropriate phase
		if (argv.data && isAgentMode) {
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(argv.data);
			} catch (parseError) {
				const detail =
					parseError instanceof Error
						? parseError.message
						: String(parseError);
				throw new Error(
					`Invalid JSON in --data flag (${detail}). Expected a JSON object, got: ${argv.data}`,
				);
			}
			if (typeof data.step === "string") {
				writeAgentResponse(await routeDataStep(data, agent));
				return;
			}
		}

		if (isAgentMode) {
			writeAgentResponse(
				await orchestrate({
					agent,
					skipMigrations: argv.skipMigrations,
					preview: argv.preview,
				}),
			);
		} else {
			await interactiveInit({ preview: argv.preview });
		}
	} catch (error) {
		// Attribute the failure to init before surfacing it: the top-level handler classifies
		// by message and would file everything here under UNKNOWN_ERROR.
		const cause = error instanceof Error ? error : new Error(String(error));
		sendError(cause, "NEON_INIT_FAILED");
		if (isAgentMode) {
			writeAgentFailure(cause);
			await closeAnalytics();
			process.exit(1);
		}
		// A human gets the top-level handler's single `ERROR: <message>` line on stderr.
		throw cause;
	}
};
