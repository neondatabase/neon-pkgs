import type yargs from "yargs";
import { Parser } from "yargs/helpers";
import { getCliName } from "../utils/cli_name.js";

type CommandModule = {
	builder: (argv: yargs.Argv) => unknown;
	handler?: (args: never) => unknown;
};

export type CommandEntry = {
	command: string;
	aliases?: string[];
	describe: string;
	load: () => Promise<CommandModule>;
};

/**
 * Every top-level command, in help order, with the metadata yargs needs to list and route it.
 * A command's module (and everything it imports) loads only when yargs selects that command,
 * so `neon --help` and `neon projects list` don't pay for `init`, `dev`, or `psql`.
 *
 * `command`, `aliases`, and `describe` must equal the module's own exports; `manifest.test.ts`
 * enforces that. `load` uses a literal specifier so bundlers can see and package each chunk.
 */
export const commandManifest: CommandEntry[] = [
	{
		command: "login",
		aliases: ["auth"],
		describe:
			"Sign in with a browser. See --help for API keys and profiles",
		load: () => import("./auth.js"),
	},
	{
		command: "profile",
		aliases: ["profiles"],
		describe: "Manage named sets of Neon credentials",
		load: () => import("./profile.js"),
	},
	{
		command: "api-keys",
		aliases: ["api-key"],
		describe: "Manage API keys",
		load: () => import("./api_keys.js"),
	},
	{
		command: "api [path]",
		describe:
			"Call any Neon API route directly (authenticated passthrough)",
		load: () => import("./api.js"),
	},
	{
		command: "me",
		describe: "Show current user",
		load: () => import("./user.js"),
	},
	{
		command: "orgs",
		aliases: ["org"],
		describe: "Manage organizations",
		load: () => import("./orgs.js"),
	},
	{
		command: "projects",
		aliases: ["project"],
		describe: "Manage projects",
		load: () => import("./projects.js"),
	},
	{
		command: "ip-allow",
		describe: "Manage IP Allow",
		load: () => import("./ip_allow.js"),
	},
	{
		command: "vpc",
		describe: "Manage VPC endpoints and project VPC restrictions",
		load: () => import("./vpc_endpoints.js"),
	},
	{
		command: "neon-auth",
		describe: "Manage Neon Auth",
		load: () => import("./neon_auth.js"),
	},
	{
		command: "branches",
		aliases: ["branch"],
		describe: "Manage branches",
		load: () => import("./branches.js"),
	},
	{
		command: "databases",
		aliases: ["database", "db"],
		describe: "Manage databases",
		load: () => import("./databases.js"),
	},
	{
		command: "roles",
		aliases: ["role"],
		describe: "Manage roles",
		load: () => import("./roles.js"),
	},
	{
		command: "operations",
		aliases: ["operation"],
		describe: "Manage operations",
		load: () => import("./operations.js"),
	},
	{
		command: "logs",
		describe: "Query branch logs",
		load: () => import("./logs.js"),
	},
	{
		command: "snapshots",
		aliases: ["snapshot"],
		describe: "Manage snapshots",
		load: () => import("./snapshots.js"),
	},
	{
		command: "inspect",
		aliases: ["inspection"],
		describe: "Inspect a branch's Postgres health and configuration",
		load: () => import("./inspect.js"),
	},
	{
		command: "connection-string [branch]",
		aliases: ["cs"],
		describe: "Get connection string",
		load: () => import("./connection_string.js"),
	},
	{
		command: "psql [branch]",
		describe: "Connect to a database via psql",
		load: () => import("./psql.js"),
	},
	{
		command: "set-context",
		describe: `Deprecated: use \`${getCliName()} link\`. Set the .neon context (raw write).`,
		load: () => import("./set_context.js"),
	},
	{
		command: "checkout [id|name]",
		describe:
			"Pin a branch in the local context (.neon) so subsequent commands target it",
		load: () => import("./checkout.js"),
	},
	{
		command: "git",
		aliases: [],
		describe:
			"Sync the checked-out Neon branch to your git branch (Preview)",
		load: () => import("./git.js"),
	},
	{
		command: "link",
		describe: "Link the current directory to a Neon project",
		load: () => import("./link.js"),
	},
	{
		command: "open",
		describe: "Open the linked project in the Neon Console",
		load: () => import("./open.js"),
	},
	{
		command: "claim",
		aliases: ["claimable"],
		describe: "Create and claim temporary Neon projects",
		load: () => import("./claim.js"),
	},
	{
		command: "init",
		describe:
			"Set up coding agents and this directory for Neon. -y is Recommended. -y with Custom flags applies those answers without prompts.",
		load: () => import("./init.js"),
	},
	{
		command: "mcp",
		describe: "Install the Neon MCP server into coding agents",
		load: () => import("./mcp.js"),
	},
	{
		command: "plugins",
		aliases: ["plugin"],
		describe: "Install the Neon plugin into coding agents",
		load: () => import("./plugins.js"),
	},
	{
		command: "skills",
		aliases: ["skill"],
		describe: "Install Neon agent skills into coding agents",
		load: () => import("./skills.js"),
	},
	{
		command: "ask",
		describe: "Ask a question about Neon",
		load: () => import("./ask.js"),
	},
	{
		command: "feedback",
		describe: "Send feedback to Neon",
		load: () => import("./feedback.js"),
	},
	{
		command: "data-api",
		describe: "Manage the Neon Data API for a database",
		load: () => import("./data_api.js"),
	},
	{
		command: "functions",
		aliases: ["function"],
		describe: "Manage Neon Functions",
		load: () => import("./functions.js"),
	},
	{
		command: "triggers",
		aliases: ["trigger"],
		describe: "Manage function triggers",
		load: () => import("./triggers.js"),
	},
	{
		command: "credentials",
		aliases: ["credential"],
		describe: "Manage branch credentials",
		load: () => import("./credentials.js"),
	},
	{
		command: "dev",
		describe: "Run Neon Functions locally with a dev server",
		load: () => import("./dev.js"),
	},
	{
		command: "diff [compare-branch]",
		describe:
			"Show a git-style schema diff between the current branch and another branch",
		load: () => import("./diff.js"),
	},
	{
		command: "config",
		describe: "Manage a branch with a neon.ts policy",
		load: () => import("./config.js"),
	},
	{
		command: "status",
		describe:
			"Show the branch's live Neon state (alias of `config status`)",
		load: () => import("./status.js"),
	},
	{
		command: "deploy",
		describe:
			"Apply a neon.ts policy to a branch (alias for `config apply`)",
		load: () => import("./deploy.js"),
	},
	{
		command: "env",
		describe: "Manage a branch's Neon env variables locally",
		load: () => import("./env.js"),
	},
	{
		command: "buckets",
		aliases: ["bucket"],
		describe: "Manage branch object-storage buckets and their objects",
		load: () => import("./bucket.js"),
	},
	{
		command: "bootstrap [directory]",
		describe:
			"Scaffold a new project from a Neon starter template, then install agent tooling and link a Neon project",
		load: () => import("./bootstrap.js"),
	},
];

const COMPLETION_COMMAND = "completion";
const COMPLETION_FLAG = "--get-yargs-completions";

const verbOf = (entry: CommandEntry): string => entry.command.split(" ")[0];

const entryByName = new Map(
	commandManifest.flatMap((entry) =>
		[verbOf(entry), ...(entry.aliases ?? [])].map(
			(name) => [name, entry] as const,
		),
	),
);

/**
 * The command yargs 17 will run for these top-level positionals: it walks them in order,
 * skips `completion`, runs the first one that names a command, and stops at the first one
 * that doesn't (`kRunYargsParserAndExecuteCommands` in yargs-factory.js).
 */
export const selectCommand = (
	positionals: readonly (string | number)[],
): CommandEntry | undefined => {
	const first = positionals.find((p) => String(p) !== COMPLETION_COMMAND);
	return first === undefined ? undefined : entryByName.get(String(first));
};

/**
 * The command whose builder yargs 17 runs to complete `--get-yargs-completions <words>`: the
 * first word that is a command's canonical name, at any position; aliases don't count there
 * (`defaultCompletion` in completion.js looks words up in the handler map, keyed by name).
 */
export const selectCompletionCommand = (
	words: readonly string[],
): CommandEntry | undefined =>
	words
		.map((word) => commandManifest.find((entry) => verbOf(entry) === word))
		.find((entry) => entry);

type ParserOptions = Parameters<typeof Parser.detailed>[1];

function assertHasGetOptions(
	argv: object,
): asserts argv is { getOptions(): ParserOptions } {
	if (!("getOptions" in argv) || typeof argv.getOptions !== "function") {
		throw new Error(
			"yargs no longer exposes getOptions(); update preloadCommand for the installed yargs",
		);
	}
}

const loaded = new Map<CommandEntry, CommandModule>();

/**
 * Import the module of the command yargs is about to run, before it runs, so its builder can
 * stay synchronous. Parses argv with yargs' own parser and the top-level options yargs will
 * use, so an option value that happens to be a command name (`--api-key projects`) can't
 * change the answer.
 */
export const preloadCommand = async (
	cli: yargs.Argv,
	args: readonly string[],
): Promise<CommandEntry | undefined> => {
	// After `--` the flag is an argument, not a completion request.
	const doubleDash = args.indexOf("--");
	const completionAt = (
		doubleDash === -1 ? args : args.slice(0, doubleDash)
	).indexOf(COMPLETION_FLAG);
	let entry: CommandEntry | undefined;
	if (completionAt >= 0) {
		entry = selectCompletionCommand(args.slice(completionAt + 1));
	} else {
		assertHasGetOptions(cli);
		const options = cli.getOptions();
		const { argv } = Parser.detailed([...args], {
			...options,
			configuration: {
				...options?.configuration,
				"populate--": true,
				"parse-positional-numbers": false,
			},
		});
		entry = selectCommand(argv._);
	}
	if (entry && !loaded.has(entry)) {
		loaded.set(entry, await entry.load());
	}
	return entry;
};

/**
 * The manifest as yargs command modules. The builder is synchronous when `preloadCommand`
 * already imported the module, which is every invocation it predicts correctly. A mispredicted
 * command still runs, because yargs 17 awaits a builder's promise when it runs a command; shell
 * completion does not await it, so a mispredicted completion lists no subcommands.
 */
export const lazyCommands = commandManifest.map((entry) => ({
	command: entry.command,
	aliases: entry.aliases,
	describe: entry.describe,
	builder: (argv: yargs.Argv) => {
		const mod = loaded.get(entry);
		return mod
			? mod.builder(argv)
			: entry.load().then((m) => {
					loaded.set(entry, m);
					return m.builder(argv);
				});
	},
	handler: async (args: never) => {
		const mod = loaded.get(entry) ?? (await entry.load());
		return mod.handler?.(args);
	},
}));
