import { defineConfig } from "@neon/config";
import type yargs from "yargs";
import { addCmd } from "./config.js";

type RealtimeEditProps = {
	cwd?: string;
	contextFile?: string;
	config?: string;
	install?: boolean;
};

export type RealtimeEnableProps = RealtimeEditProps & {
	allowedOrigins?: readonly string[];
};

const commonProps = (props: RealtimeEditProps) => ({
	install: props.install ?? true,
	...(props.cwd !== undefined ? { cwd: props.cwd } : {}),
	...(props.contextFile !== undefined
		? { contextFile: props.contextFile }
		: {}),
	...(props.config !== undefined ? { config: props.config } : {}),
});

/** Declare Realtime locally; this command makes no API calls. */
export const enable = async (props: RealtimeEnableProps): Promise<void> => {
	const realtime =
		props.allowedOrigins === undefined
			? true
			: { allowedOrigins: props.allowedOrigins };
	// Validate the same constraints `neon.ts` will enforce before writing the file.
	defineConfig({ realtime });
	await addCmd({
		target: {
			kind: "realtime",
			enabled: true,
			...(props.allowedOrigins !== undefined
				? { allowedOrigins: props.allowedOrigins }
				: {}),
		},
		...commonProps(props),
	});
};

/** Declare Realtime disabled locally; this command makes no API calls. */
export const disable = async (props: RealtimeEditProps): Promise<void> => {
	await addCmd({
		target: { kind: "realtime", enabled: false },
		...commonProps(props),
	});
};

const editOptions = (argv: yargs.Argv) =>
	argv.strict().options({
		config: {
			describe:
				"Path to the neon.ts to edit (defaults to the neon.ts next to .neon, or in cwd without one; created there when missing)",
			type: "string",
		},
		install: {
			describe:
				"Install @neon/config and @neon/env when creating neon.ts. On by default; use --no-install to skip",
			type: "boolean",
			default: true,
		},
	});

export const command = "realtime";
export const describe = "Manage Neon Realtime in neon.ts";
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 realtime <sub-command> [options]")
		.command(
			"enable",
			"Declare Realtime enabled in neon.ts",
			(yargs) =>
				editOptions(yargs).option("allowed-origin", {
					describe:
						'Allowed browser origin (repeatable). "*" allows every origin',
					type: "array",
					string: true,
				}),
			(args) =>
				enable({
					...(args as RealtimeEditProps),
					...(args.allowedOrigin !== undefined
						? { allowedOrigins: args.allowedOrigin }
						: {}),
				}),
		)
		.command(
			"disable",
			"Declare Realtime disabled in neon.ts",
			editOptions,
			(args) => disable(args),
		);

export const handler = (_args: yargs.Arguments) => {
	/* Yargs requires a handler for command groups. */
};
