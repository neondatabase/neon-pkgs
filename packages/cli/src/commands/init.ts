import type yargs from "yargs";
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

/** ` at position 12`, or nothing when the parser did not report one. */
const parsePosition = (parseError: unknown): string => {
	const message = parseError instanceof Error ? parseError.message : "";
	const at = message.match(/at position (\d+)/);
	return at === null ? "" : ` at position ${at[1]}`;
};

export const handler = async (argv: {
	agent?: boolean;
	data?: string;
	profile?: string;
}) => {
	// Auto-detect agent from environment. When --agent is explicitly passed,
	// always detect (the user asked for agent mode). Otherwise, require
	// non-TTY stdin to distinguish agent from human in terminal.
	//
	// Handler failures need the caller's output format; `ensureAuth` runs earlier
	// and reports directly to stderr.
	const agent =
		(argv.agent || !process.stdin.isTTY ? detectAgent() : null) ||
		undefined;
	const isAgentMode = argv.agent || agent !== undefined;

	try {
		// --data with a "step" field routes to the appropriate phase
		if (argv.data && isAgentMode) {
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(argv.data);
			} catch (parseError) {
				// Neither the payload nor the parser's message may appear here. `--data`
				// carries whatever the caller put in it — a connection string, an API key —
				// and V8 quotes a window of the input around the syntax error, so both would
				// travel into the error message, onto stdout, and into `sendError`'s
				// analytics payload. `@neon-internals/cli-core/credentials` discards the same
				// message for the same reason. The position is a number and says enough.
				throw new Error(
					`Invalid JSON in --data flag${parsePosition(parseError)}. Expected a JSON object.`,
				);
			}
			if (typeof data.step === "string") {
				writeAgentResponse(await routeDataStep(data, agent));
				return;
			}
		}

		if (isAgentMode) {
			writeAgentResponse(await orchestrate({ agent }));
		} else {
			await interactiveInit();
		}
	} catch (error) {
		const cause = error instanceof Error ? error : new Error(String(error));
		if (isAgentMode) {
			// Agent mode answers and exits here, so nothing else will report this. Attribute
			// it to init and flush before exiting — `process.exit` drops in-flight events.
			sendError(cause, "NEON_INIT_FAILED");
			writeAgentFailure(cause);
			await closeAnalytics();
			process.exit(1);
		}
		// A human gets the top-level handler's single `ERROR: <message>` line on stderr, and
		// its `sendError`. Reporting here as well would file one failure as two events.
		throw cause;
	}
};
