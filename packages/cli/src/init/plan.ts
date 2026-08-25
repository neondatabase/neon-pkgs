export type InitPlanInput = {
	empty: boolean;
	linked: boolean;
	yes: boolean;
};

export type InitStep = readonly string[];

export const directoryIsEmpty = (names: readonly string[]): boolean =>
	names.filter((name) => name !== ".git").length === 0;

export const planInit = (input: InitPlanInput): InitStep[] => {
	const y = input.yes ? (["-y"] as const) : [];
	if (input.empty) {
		const steps: InitStep[] = [
			input.yes
				? ["bootstrap", ".", "--default", "--no-link"]
				: ["bootstrap", "."],
			["skills", "update", ...y],
		];
		if (input.yes && !input.linked) {
			steps.push(["link", "--yes"]);
		}
		steps.push(["mcp", ...y]);
		return steps;
	}

	const steps: InitStep[] = [["skills", ...y]];
	if (!input.linked) {
		steps.push(input.yes ? ["link", "--yes"] : ["link"]);
	}
	steps.push(["mcp", ...y]);
	return steps;
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
