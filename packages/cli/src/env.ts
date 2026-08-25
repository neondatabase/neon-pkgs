export const isCi = () => {
	return process.env.CI !== "false" && Boolean(process.env.CI);
};

export const isDebug = () => {
	return Boolean(process.env.DEBUG);
};

export type CliAgent = "claude-code" | "codex";

export const getCliAgent = (env: NodeJS.Dict<string>): CliAgent | undefined => {
	const claudeCode = env.CLAUDE_CODE_CHILD_SESSION === "1";
	const codex =
		Boolean(env.CODEX_THREAD_ID?.trim()) ||
		Boolean(env.CODEX_SESSION_ID?.trim());

	if (claudeCode === codex) return undefined;
	return claudeCode ? "claude-code" : "codex";
};

export const getGithubEnvVars = (env: NodeJS.Dict<string>) => {
	const vars = [
		// github action info
		"GITHUB_ACTION_PATH",

		// source github repository
		"GITHUB_REPOSITORY",

		// environment info
		"GITHUB_RUN_ID",
		"GITHUB_RUN_NUMBER",
		"GITHUB_SERVER_URL",
		"GITHUB_WORKFLOW_REF",
		"RUNNER_ARCH",
		"RUNNER_ENVIRONMENT",
		"RUNNER_OS",
	];

	const map = new Map();
	vars.forEach((v) => {
		let value = env[v];
		if (value === undefined || value === "") {
			return;
		}
		if (v === "GITHUB_ACTION_PATH") {
			value = value.includes("actions/")
				? value.replace(/^.*actions\/(.+)$/, "$1")
				: value;
		}

		map.set(v, value);
	});

	return Object.fromEntries(map);
};
