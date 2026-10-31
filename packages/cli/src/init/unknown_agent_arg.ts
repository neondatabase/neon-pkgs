const UNKNOWN_AGENT_COMMANDS = ["link"] as const;

type UnknownAgentCommand = (typeof UNKNOWN_AGENT_COMMANDS)[number];

const unknownAgentArgHint = (
	command: UnknownAgentCommand,
	cliName: string,
): string =>
	`${cliName} ${command} has no --agent. Pass --project-id <id> to link without a TTY, or run ${cliName} ${command} in a terminal.`;

const BOOLEAN_FLAGS = new Set([
	"-y",
	"--yes",
	"--default",
	"--force",
	"-h",
	"--help",
	"-v",
	"--version",
	"--color",
	"--no-color",
	"--analytics",
	"--no-analytics",
	"--oauth",
	"--project",
	"--global",
	"--read-only",
	"--readonly",
	"--clear",
	"--checks",
	"--no-checks",
	"--env-pull",
	"--no-env-pull",
	"--no-agent-setup",
	"--no-link",
	"--no-config",
	"--claimable",
	"--config",
	"--list",
	"--list-templates",
	"--force-auth",
	"--no-force-auth",
]);

const isUnknownAgentCommand = (token: string): token is UnknownAgentCommand => {
	for (const command of UNKNOWN_AGENT_COMMANDS) {
		if (command === token) {
			return true;
		}
	}
	return false;
};

const commandFromArgv = (
	argv: readonly string[],
): UnknownAgentCommand | undefined => {
	let skipValue = false;
	for (const token of argv) {
		if (skipValue) {
			skipValue = false;
			continue;
		}
		if (token === "--") {
			break;
		}
		if (token.startsWith("-")) {
			const flag = token.split("=")[0];
			if (
				flag !== undefined &&
				!token.includes("=") &&
				!BOOLEAN_FLAGS.has(flag)
			) {
				skipValue = true;
			}
			continue;
		}
		if (isUnknownAgentCommand(token)) {
			return token;
		}
	}
	return undefined;
};

export const rewriteUnknownAgentArg = (input: {
	message: string;
	argv: readonly string[];
	cliName: string;
}): string | undefined => {
	if (
		input.message !== "Unknown argument: agent" &&
		input.message !== "Unknown argument: a"
	) {
		return undefined;
	}
	const command = commandFromArgv(input.argv);
	if (command === undefined) {
		return undefined;
	}
	return unknownAgentArgHint(command, input.cliName);
};
