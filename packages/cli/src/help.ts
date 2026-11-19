import chalk from "chalk";
import cliui from "cliui";
import type yargs from "yargs";
import { REDACTED_INVALID_VALUE } from "./errors.js";
import {
	globalOptionsTrailer,
	helpWidth,
	wrapHelpText,
} from "./utils/help_text.js";
import {
	consumeBlockIfMatches,
	consumeNextMatching,
	drawPointer,
	splitColumns,
} from "./utils/ui.js";

// target width for the leftmost column
const SPACE_WIDTH = 20;
const DESCRIPTION_GUTTER = 4;

const wrapDescription = (text: string) =>
	wrapHelpText(
		text,
		Math.max(1, helpWidth() - SPACE_WIDTH - DESCRIPTION_GUTTER),
	);

const isGlobalOptionsHeader = (header: string) =>
	/global options:/i.test(header);

const isTopLevelUsage = (usage: string) => /^\S+ <command>/.test(usage);

const renderOptionBlock = (optionsBlock: string[]): string[] => {
	const result: string[] = [];
	const [header, ...body] = optionsBlock;
	if (header === undefined) {
		return result;
	}
	result.push(header);
	body.forEach((line) => {
		const [option, description] = splitColumns(line);
		const ui = cliui({
			width: helpWidth(),
			wrap: false,
		});
		if (option.startsWith("-")) {
			ui.div({
				text: chalk.green(option),
				padding: [0, 0, 0, 0],
			});
			ui.div(
				{
					text: chalk.gray(drawPointer(SPACE_WIDTH)),
					width: SPACE_WIDTH,
					padding: [0, 2, 0, 0],
				},
				{
					text: chalk.rgb(
						210,
						210,
						210,
					)(wrapDescription(description ?? "")),
					padding: [0, 0, 0, 0],
				},
			);
		} else {
			ui.div(
				{
					padding: [0, 0, 0, 0],
					text: "",
					width: SPACE_WIDTH,
				},
				{
					text: chalk.rgb(210, 210, 210)(wrapDescription(option)),
					padding: [0, 0, 0, 0],
				},
			);
		}

		result.push(ui.toString());
	});
	result.push("");
	return result;
};

const formatHelp = (help: string) => {
	const lines = help.split("\n");
	const result = [] as string[];
	// full command, like `neonctl projects list`
	const topLevelCommand = consumeNextMatching(lines, /^.*/);

	if (topLevelCommand) {
		result.push(
			chalk.bold(
				topLevelCommand.replace(
					"[options]",
					chalk.reset.green("[options]"),
				),
			),
		);
		result.push("");
	}

	const consumeCommands = () => {
		const commandsBlock = consumeBlockIfMatches(lines, /^Commands:/);
		if (commandsBlock.length === 0) {
			return;
		}
		const header = commandsBlock.shift();
		if (header === undefined) {
			return;
		}
		result.push(header);
		const ui = cliui({
			width: helpWidth(),
			wrap: false,
		});
		commandsBlock.forEach((line) => {
			if (/^\s{3,}/.exec(line)) {
				ui.div(
					{
						text: "",
						width: SPACE_WIDTH,
						padding: [0, 0, 0, 0],
					},
					{
						text: wrapDescription(line.trim()),
						padding: [0, 0, 0, 0],
					},
				);
				return;
			}

			const [command, description] = splitColumns(line);

			// patch the previous command if it was multiline
			if (!description && ui.rows.length > 1) {
				ui.rows[ui.rows.length - 2][0].text += command;
				return;
			}

			ui.div(chalk.cyan(command));
			ui.div(
				{
					text: chalk.gray(drawPointer(SPACE_WIDTH)),
					width: SPACE_WIDTH,
					padding: [0, 0, 0, 0],
				},
				{ text: wrapDescription(description), padding: [0, 0, 0, 2] },
			);
		});
		result.push(ui.toString());
		result.push("");
	};

	const consumePositionals = () => {
		const positionalsBlock = consumeBlockIfMatches(lines, /Positionals:/);
		if (positionalsBlock.length === 0) {
			return;
		}
		const header = positionalsBlock.shift();
		if (header === undefined) {
			return;
		}
		result.push(header);
		const ui = cliui({
			width: helpWidth(),
			wrap: false,
		});
		positionalsBlock.forEach((line) => {
			const [positional, description] = splitColumns(line);
			ui.div(
				{
					text: positional,
					width: SPACE_WIDTH,
					padding: [0, 2, 0, 0],
				},
				{
					text: wrapDescription(description),
					padding: [0, 0, 0, 0],
				},
			);
		});
		result.push(ui.toString());
		result.push("");
	};

	consumeCommands();
	consumePositionals();

	// command description
	// example command to see: neonctl projects list
	const descriptionBlock = consumeBlockIfMatches(lines, /^(?!.*options:)/i);
	if (descriptionBlock.length > 0) {
		result.push(...descriptionBlock);
		result.push("");
	}

	// Nested parents (`functions domains`) put Commands after the description;
	// `projects` puts them before it. `functions deploy` puts Positionals after
	// the description; `branches rename` puts them before it.
	consumeCommands();
	consumePositionals();

	const optionBlocks: string[][] = [];
	while (true) {
		const optionsBlock = consumeBlockIfMatches(lines, /.*options:/i);
		if (optionsBlock.length === 0) {
			break;
		}
		optionBlocks.push(optionsBlock);
	}

	for (const block of optionBlocks) {
		const header = block[0];
		if (header !== undefined && !isGlobalOptionsHeader(header)) {
			result.push(...renderOptionBlock(block));
		}
	}

	const globalBlocks = optionBlocks.filter((block) => {
		const header = block[0];
		return header !== undefined && isGlobalOptionsHeader(header);
	});
	if (topLevelCommand !== null && isTopLevelUsage(topLevelCommand)) {
		for (const block of globalBlocks) {
			result.push(...renderOptionBlock(block));
		}
	} else if (globalBlocks.length > 0 && topLevelCommand !== null) {
		result.push(globalOptionsTrailer(topLevelCommand));
		result.push("");
	}

	const exampleBlock = consumeBlockIfMatches(lines, /Examples:/);
	if (exampleBlock.length > 0) {
		result.push(exampleBlock.shift() as string);
		const ui = cliui({
			width: helpWidth(),
			wrap: false,
		});
		for (const line of exampleBlock) {
			const [command, description] = splitColumns(line);
			ui.div({
				text: chalk.bold(command),
				padding: [0, 0, 0, 0],
			});
			ui.div({
				text: chalk.reset(wrapDescription(description)),
				padding: [0, 0, 0, 2],
			});
		}
		result.push(ui.toString());
	}

	return [...result, ...lines];
};

const writeHelp = (help: string, stream: NodeJS.WriteStream) =>
	new Promise<void>((resolve, reject) => {
		stream.write(`${formatHelp(help).join("\n")}\n`, (err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});

export const showHelp = async (argv: yargs.Argv) => {
	await writeHelp(await argv.getHelp(), process.stdout);
	process.exit(0);
};

/**
 * Where yargs was when it rejected a command: the command path it had matched
 * (`["functions"]` for `neon functions logs`) and the names and aliases it could
 * have routed to from there.
 */
export type CommandScope = { path: string[]; commands: string[] };

/**
 * Names callers try that are not a misspelling of a command, keyed by the full
 * path. `{cli}` is the invoked binary.
 */
const GUESSES: Record<string, string> = {
	whoami: "Did you mean `{cli} me`?",
	keys: "Did you mean `{cli} api-keys`?",
	sql: "Did you mean `{cli} psql`?",
	storage: "Did you mean `{cli} buckets`?",
	regions:
		"There is no regions command. `{cli} projects create --help` lists the region IDs.",
	"functions logs":
		"Function logs are under `{cli} logs`, for example: {cli} logs query --source function",
};

const editDistance = (a: string, b: string): number => {
	let row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const next = [i];
		for (let j = 1; j <= b.length; j++) {
			next[j] = Math.min(
				(row[j] ?? 0) + 1,
				(next[j - 1] ?? 0) + 1,
				(row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		row = next;
	}
	return row[b.length] ?? 0;
};

/**
 * The closest command within two edits that starts with the same letter. The
 * letter keeps `get` from suggesting `set`.
 */
const nearest = (unknown: string, commands: string[]): string | undefined => {
	let best: string | undefined;
	let bestDistance = 3;
	for (const command of commands) {
		if (command[0] !== unknown[0]) continue;
		const distance = editDistance(unknown, command);
		if (distance < bestDistance && distance < unknown.length) {
			best = command;
			bestDistance = distance;
		}
	}
	return best;
};

/**
 * A line to print under yargs' "Unknown command: x" / "Unknown commands: x, y",
 * or undefined when there is nothing useful to say.
 */
export const unknownCommandHint = (
	message: string,
	scope: CommandScope,
	cliName: string,
): string | undefined => {
	const unknown = /^Unknown commands?: ([^,\s]+)/.exec(message)?.[1];
	if (unknown === undefined) return undefined;
	const guess = GUESSES[[...scope.path, unknown].join(" ")];
	if (guess !== undefined) return guess.split("{cli}").join(cliName);
	const match = nearest(unknown, scope.commands);
	return match === undefined
		? undefined
		: `Did you mean \`${[cliName, ...scope.path, match].join(" ")}\`?`;
};

/**
 * A yargs validation failure: a missing required option or positional, an unknown
 * subcommand, a value outside `choices`. Carries the failing command's help, captured
 * in `.fail` because yargs has restored the parent's context by the time the error
 * reaches the caller.
 */
export class UsageError extends Error {
	readonly help: string;
	/** The command yargs was running and its subcommands, for an unknown-command hint. */
	readonly scope: CommandScope | undefined;

	constructor(message: string, help: string, scope?: CommandScope) {
		super(message);
		this.help = help;
		this.scope = scope;
	}
}

/** On stderr, so `-o json` stdout stays empty. */
export const showUsageErrorHelp = (err: UsageError) =>
	writeHelp(err.help, process.stderr);

/**
 * The yargs `.fail` handler. yargs passes its usage instance as the third argument
 * (`@types/yargs` declares it as `Argv`). Errors thrown by a handler, a `coerce`, or the
 * parser arrive with their own `err` and are rethrown unchanged.
 */
export const failOnUsageError = (
	msg: string | null,
	err: Error | null,
	usage: unknown,
	scope?: () => CommandScope,
) => {
	if (err) {
		throw err;
	}
	if (
		typeof usage !== "object" ||
		usage === null ||
		!("help" in usage) ||
		typeof usage.help !== "function"
	) {
		throw new Error(
			"yargs no longer passes its usage instance to .fail(); update failOnUsageError for the installed yargs",
		);
	}
	const help: unknown = usage.help();
	if (typeof help !== "string") {
		throw new Error("yargs usage.help() did not return a string");
	}
	throw new UsageError(
		redactRejectedChoices(msg ?? "Invalid usage"),
		help,
		scope?.(),
	);
};

/**
 * yargs answers a value outside `choices` with `Argument: <key>, Given: <values>, Choices:
 * <choices>`, one line per flag, in English because `index.ts` pins `.locale("en")`. Each
 * given value is JSON-quoted, which leaves U+2028/U+2029 unescaped, hence `[^\n]` over `.`;
 * the match runs to the last `, Choices: ` so a value containing that text is still covered.
 */
const redactRejectedChoices = (msg: string): string =>
	msg.replace(
		/^(\s*Argument: [^,\n]+, Given: )[^\n]*(, Choices: )/gm,
		`$1${REDACTED_INVALID_VALUE}$2`,
	);

type YargsInternals = {
	getInternalMethods(): {
		getContext(): { commands: string[] };
		getCommandInstance(): { getCommands(): string[] };
	};
};

function assertYargsInternals(argv: object): asserts argv is YargsInternals {
	if (
		!("getInternalMethods" in argv) ||
		typeof argv.getInternalMethods !== "function"
	) {
		throw new Error(
			"yargs no longer exposes getInternalMethods(); update isBareParentCommand for the installed yargs",
		);
	}
}

/**
 * True when the command yargs is running groups subcommands and none was given, at any
 * depth: `neon config add`, `neon snapshots schedule`. `@types/yargs` doesn't declare the
 * running command's context, so this reads yargs 17's internals.
 */
export const isBareParentCommand = (
	argv: yargs.Argv,
	positionals: readonly (string | number)[],
) => {
	assertYargsInternals(argv);
	const internals = argv.getInternalMethods();
	const path = internals.getContext().commands;
	return (
		path.length > 0 &&
		positionals.length === path.length &&
		internals.getCommandInstance().getCommands().length > 0
	);
};

/**
 * The command yargs is running and the commands it can route to from there. Read in
 * `.fail`, for the same reason {@link UsageError} captures the help there.
 */
export const commandScope = (argv: yargs.Argv): CommandScope => {
	assertYargsInternals(argv);
	const internals = argv.getInternalMethods();
	return {
		path: [...internals.getContext().commands],
		commands: internals.getCommandInstance().getCommands(),
	};
};
