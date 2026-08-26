export type InitAgentSetup = "plugin" | "skills-mcp" | "skip";

export type InitStep = readonly string[];

export const directoryIsEmpty = (names: readonly string[]): boolean =>
	names.filter((name) => name !== ".git").length === 0;

export const bootstrapInitStep = (yes: boolean): InitStep =>
	yes ? ["bootstrap", ".", "--default"] : ["bootstrap", "."];

export const planAgentSteps = (input: {
	yes: boolean;
	agentSetup: InitAgentSetup;
}): InitStep[] => {
	const y = input.yes ? (["-y"] as const) : [];
	if (input.agentSetup === "plugin") {
		return [["plugins", ...y]];
	}
	if (input.agentSetup === "skills-mcp") {
		return [
			["skills", ...y],
			["mcp", ...y],
		];
	}
	return [];
};

export const planExistingInit = (input: {
	linked: boolean;
	yes: boolean;
	agentSetup: InitAgentSetup;
}): InitStep[] => {
	const steps: InitStep[] = [...planAgentSteps(input)];
	if (!input.linked) {
		steps.push(input.yes ? ["link", "--yes"] : ["link"]);
	}
	steps.push(
		input.yes
			? ["config", "init", "--services", "none"]
			: ["config", "init"],
	);
	return steps;
};

export const resolveInitAgentSetup = async (input: {
	yes: boolean;
	interactive: boolean;
	hasProjectPlugins: boolean;
	pick: () => Promise<InitAgentSetup>;
}): Promise<InitAgentSetup> => {
	if (input.yes) {
		return input.hasProjectPlugins ? "plugin" : "skills-mcp";
	}
	if (input.interactive) {
		return input.pick();
	}
	return "skills-mcp";
};

export type ChildForward = {
	configDir?: string;
	profile?: string;
	apiHost: string;
	contextFile: string;
	analytics?: boolean;
};

export const childArgv = (step: InitStep, forward: ChildForward): string[] => {
	const args = [...step];
	if (forward.configDir) {
		args.push("--config-dir", forward.configDir);
	}
	if (forward.profile) {
		args.push("--profile", forward.profile);
	}
	args.push("--api-host", forward.apiHost);
	args.push("--context-file", forward.contextFile);
	if (forward.analytics === false) {
		args.push("--no-analytics");
	}
	return args;
};
