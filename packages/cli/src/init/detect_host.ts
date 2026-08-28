import type { AgentType } from "../mcp/agents.js";

const CLAUDE_ENV = ["CLAUDECODE", "CLAUDE_CODE", "CLAUDE_CLI"] as const;

const CURSOR_ENV = [
	"CURSOR_TRACE_ID",
	"CURSOR_EXTENSION_HOST_ROLE",
	"CURSOR_LAYOUT",
	"CURSOR_SPAWNED_BY_EXTENSION_ID",
] as const;

const CURSOR_PATH_ENV = [
	"GIT_ASKPASS",
	"VSCODE_GIT_ASKPASS_NODE",
	"VSCODE_GIT_ASKPASS_MAIN",
	"VSCODE_IPC_HOOK_CLI",
] as const;

const looksLikeCursor = (value: string): boolean => {
	const lower = value.toLowerCase();
	return (
		lower.includes("cursor.app") ||
		lower.includes("/cursor/") ||
		lower.includes("/.cursor/")
	);
};

const isSet = (value: string | undefined): boolean => value !== undefined;

const isNonEmpty = (value: string | undefined): boolean =>
	typeof value === "string" && value.trim() !== "";

export function detectAgent(
	env: NodeJS.ProcessEnv = process.env,
): AgentType | null {
	if (CLAUDE_ENV.some((key) => env[key] === "1")) {
		return "claude-code";
	}
	if (env.CODEX === "1") {
		return "codex";
	}
	if (isNonEmpty(env.CODEX_THREAD_ID) || isNonEmpty(env.CODEX_SESSION_ID)) {
		return "codex";
	}
	if (env.CLINE === "1") {
		return "cline";
	}
	if (env.GEMINI_CLI === "1") {
		return "gemini-cli";
	}

	if (
		env.TERM_PROGRAM === "cursor" ||
		CURSOR_ENV.some((key) => isSet(env[key])) ||
		CURSOR_PATH_ENV.some((key) => {
			const value = env[key];
			return typeof value === "string" && looksLikeCursor(value);
		})
	) {
		return "cursor";
	}

	if (env.TERM_PROGRAM === "windsurf") {
		return "windsurf";
	}

	if (
		env.TERM_PROGRAM === "vscode" ||
		isSet(env.VSCODE_PID) ||
		isSet(env.VSCODE_CWD)
	) {
		return "vscode";
	}

	return null;
}
