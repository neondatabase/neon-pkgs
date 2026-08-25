import { existsSync } from "node:fs";

/**
 * Detects the IDE/editor the terminal is running in, regardless of which
 * agent is active. Used for extension installation — the extension goes
 * into the IDE, not the agent.
 *
 * Returns an Editor-compatible string: "Cursor", "VS Code", "Windsurf", or null.
 */
export function detectIde(): "Cursor" | "VS Code" | "Windsurf" | null {
	const env = process.env;

	// Cursor: check explicit Cursor env vars (set in extension host context)
	if (
		env.TERM_PROGRAM === "cursor" ||
		env.CURSOR_TRACE_ID !== undefined ||
		env.CURSOR_EXTENSION_HOST_ROLE !== undefined ||
		env.CURSOR_LAYOUT !== undefined ||
		env.CURSOR_SPAWNED_BY_EXTENSION_ID !== undefined
	) {
		return "Cursor";
	}

	// Cursor: check app paths in env vars (reliable from terminal context)
	if (
		env.GIT_ASKPASS?.includes("Cursor.app") ||
		env.VSCODE_GIT_ASKPASS_NODE?.includes("Cursor.app") ||
		env.GIT_ASKPASS?.includes("cursor") ||
		env.VSCODE_GIT_ASKPASS_NODE?.includes("cursor")
	) {
		return "Cursor";
	}

	// Windsurf
	if (env.TERM_PROGRAM === "windsurf") {
		return "Windsurf";
	}

	// At this point we know we're in a VS Code-like environment if any
	// VSCODE_ env vars are set. But is it actually Cursor with generic env vars?
	if (
		env.TERM_PROGRAM === "vscode" ||
		env.VSCODE_PID !== undefined ||
		env.VSCODE_CWD !== undefined
	) {
		// Check any remaining env vars that might contain "cursor" (case-insensitive)
		// This catches VSCODE_IPC_HOOK_CLI, PATH additions, etc.
		const envValues = Object.values(env).join("\n").toLowerCase();
		if (
			envValues.includes("cursor.app") ||
			envValues.includes("/cursor/")
		) {
			return "Cursor";
		}

		// If only Cursor is installed (not VS Code), it must be Cursor
		if (isCursorInstalled() && !isVSCodeInstalled()) {
			return "Cursor";
		}

		return "VS Code";
	}

	return null;
}

export function isCursorInstalled(): boolean {
	if (process.platform === "darwin") {
		return existsSync("/Applications/Cursor.app");
	}
	if (process.platform === "linux") {
		return existsSync("/usr/share/cursor") || existsSync("/usr/bin/cursor");
	}
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA || "";
		return (
			existsSync(`${localAppData}\\Programs\\Cursor\\Cursor.exe`) ||
			existsSync(`${localAppData}\\cursor\\Cursor.exe`)
		);
	}
	return false;
}

export function isVSCodeInstalled(): boolean {
	if (process.platform === "darwin") {
		return existsSync("/Applications/Visual Studio Code.app");
	}
	if (process.platform === "linux") {
		return existsSync("/usr/share/code") || existsSync("/usr/bin/code");
	}
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA || "";
		const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
		return (
			existsSync(
				`${localAppData}\\Programs\\Microsoft VS Code\\Code.exe`,
			) || existsSync(`${programFiles}\\Microsoft VS Code\\Code.exe`)
		);
	}
	return false;
}

/**
 * Detects which agent/IDE is running the CLI from environment variables.
 * Returns the add-mcp compatible agent ID (e.g. "cursor", "claude-code").
 *
 * Delegates IDE detection to detectIde() to avoid duplicating Cursor/VS Code
 * heuristics, then checks for agent-specific env vars.
 */
export function detectAgent(): string | null {
	const env = process.env;

	// Agent-specific env vars (checked first — these are unambiguous)
	if (
		env.CLAUDECODE === "1" ||
		env.CLAUDE_CODE === "1" ||
		env.CLAUDE_CLI === "1"
	) {
		return "claude-code";
	}
	if (env.CODEX === "1") return "codex";
	if (env.CLINE === "1") return "cline";

	// Fall back to IDE detection (Cursor, VS Code, Windsurf)
	const ide = detectIde();
	if (ide) {
		const IDE_TO_AGENT: Record<string, string> = {
			Cursor: "cursor",
			"VS Code": "vscode",
			Windsurf: "windsurf",
		};
		return IDE_TO_AGENT[ide] ?? null;
	}

	return null;
}
