export const isCi = () => {
	return process.env.CI !== "false" && Boolean(process.env.CI);
};

export const isDebug = () => {
	return Boolean(process.env.DEBUG);
};

export type CliAgent = "claude-code" | "codex" | "cursor";

export const getCliAgent = (env: NodeJS.Dict<string>): CliAgent | undefined => {
	const markers: ReadonlyArray<readonly [CliAgent, boolean]> = [
		["claude-code", env.CLAUDE_CODE_CHILD_SESSION === "1"],
		[
			"codex",
			env.CODEX_CI === "1" &&
				(Boolean(env.CODEX_THREAD_ID?.trim()) ||
					Boolean(env.CODEX_SESSION_ID?.trim())),
		],
		// Cursor documents CURSOR_AGENT for detecting shells its agent runs.
		// TERM_PROGRAM and CURSOR_TRACE_ID also appear in terminals a person
		// opens in Cursor, so they never attribute.
		["cursor", env.CURSOR_AGENT === "1"],
	];
	const active = markers.filter(([, present]) => present);
	return active.length === 1 ? active[0][0] : undefined;
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
