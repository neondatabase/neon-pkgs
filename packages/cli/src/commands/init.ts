import {
	detectAgent,
	enrichResponse,
	interactiveInit,
	orchestrate,
	routeDataStep,
} from "neon-init";
import type yargs from "yargs";
import { sendError } from "../analytics.js";
import { credentialInputs } from "../auth_selection.js";
import { log } from "../log.js";

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

export const handler = async (argv: {
	agent?: boolean;
	data?: string;
	skipMigrations?: boolean;
	preview?: boolean;
	profile?: string;
}) => {
	// `init` delegates its whole auth flow to `neon-init`, which reads the default credentials
	// directly and re-invokes the CLI as a subprocess. It has no way to be told which profile
	// to use, so honouring a selection here is not possible yet — and silently running as the
	// default account would be worse than refusing, because naming an account is the entire
	// job of the thing being ignored.
	//
	// `NEON_PROFILE` counts just as much as the flag. Checking only the flag left the case that
	// is easier to hit by accident: a profile exported once into a shell then silently
	// disregarded by every `neon init` run in it.
	const selectedProfile =
		argv.profile?.trim() || credentialInputs().profileEnv.trim();
	if (selectedProfile) {
		const how = argv.profile?.trim()
			? "--profile"
			: "NEON_PROFILE is set, so";
		throw new Error(
			`${how} \`neon init\` would run as the default account instead of "${selectedProfile}", and it does not support profile selection yet. Run it without one, or set the project up with \`neon --profile ${selectedProfile} link\`.`,
		);
	}

	try {
		// Auto-detect agent from environment. When --agent is explicitly passed,
		// always detect (the user asked for agent mode). Otherwise, require
		// non-TTY stdin to distinguish agent from human in terminal.
		const agent =
			(argv.agent || !process.stdin.isTTY ? detectAgent() : null) ||
			undefined;
		const isAgentMode = argv.agent || agent !== undefined;

		// --data with a "step" field routes to the appropriate phase
		if (argv.data && isAgentMode) {
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(argv.data);
			} catch {
				log.error(
					"Invalid JSON in --data flag. Expected a JSON object.",
				);
				process.exit(1);
				return;
			}
			if (typeof data.step === "string") {
				const result = await routeDataStep(data, agent);
				log.info(JSON.stringify(enrichResponse(result), null, 2));
				return;
			}
		}

		if (isAgentMode) {
			const result = await orchestrate({
				agent,
				skipMigrations: argv.skipMigrations,
				preview: argv.preview,
			});
			log.info(JSON.stringify(enrichResponse(result), null, 2));
		} else {
			await interactiveInit({ preview: argv.preview });
		}
	} catch {
		const exitError = new Error(`failed to run neon-init`);
		sendError(exitError, "NEON_INIT_FAILED");
		process.exit(1);
	}
};
