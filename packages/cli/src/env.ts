import { isatty } from "node:tty";

export const isCi = () => {
	return process.env.CI !== "false" && Boolean(process.env.CI);
};

export const isInteractiveTerminal = (): boolean =>
	!isCi() && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

export const isDebug = () => {
	return Boolean(process.env.DEBUG);
};

// isatty does not construct process.stdin, which every command would otherwise pay for.
export const getTty = () => ({
	stdin: isatty(0),
	stdout: isatty(1),
});

type KnownCliAgent =
	| "claude-code"
	| "codex"
	| "cursor"
	| "opencode"
	| "gemini-cli"
	| "github-copilot-cli"
	| "antigravity"
	| "kilo"
	| "qwen-code"
	| "cline"
	| "openclaw"
	| "amp";

const AI_AGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const isNonEmpty = (value: string | undefined): boolean =>
	Boolean(value?.trim());

export const getCliAgent = (env: NodeJS.Dict<string>): string | undefined => {
	const markers: ReadonlyArray<readonly [KnownCliAgent, boolean]> = [
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
		// These three set their marker on every command run inside them,
		// including ones a person types in the harness's `!` shell mode, so
		// they attribute the harness rather than strictly the agent.
		// Kilo is an OpenCode fork and sets OPENCODE=1 alongside KILO=1.
		["opencode", env.OPENCODE === "1" && env.KILO !== "1"],
		["kilo", env.KILO === "1"],
		["gemini-cli", env.GEMINI_CLI === "1"],
		["qwen-code", env.QWEN_CODE === "1"],
		["github-copilot-cli", env.COPILOT_CLI === "1"],
		["antigravity", isNonEmpty(env.ANTIGRAVITY_AGENT)],
		["amp", isNonEmpty(env.AMP_CURRENT_THREAD_ID)],
		// Set on the terminals Cline opens for its own commands.
		["cline", env.CLINE_ACTIVE === "true"],
		// OpenClaw's `!` shell sets OPENCLAW_SHELL=tui-local instead.
		["openclaw", env.OPENCLAW_SHELL === "exec"],
	];
	const active = markers.filter(([, present]) => present);
	if (active.length > 0) {
		return active.length === 1 ? active[0][0] : undefined;
	}
	// AI_AGENT is the cross-agent convention (Hermes, Crush, v0); its value is
	// free-form, so anything that is not a short slug is dropped.
	const declared = env.AI_AGENT?.trim().toLowerCase();
	return declared && AI_AGENT_NAME.test(declared) ? declared : undefined;
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
