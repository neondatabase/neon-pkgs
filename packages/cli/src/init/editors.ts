import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execa } from "execa";
import type { Editor } from "./types.js";

/**
 * Gets VS Code's global config directory based on the platform
 */
export function getVSCodeGlobalConfigDir(homeDir: string): string | null {
	const platform = process.platform;

	if (platform === "darwin") {
		// macOS: ~/Library/Application Support/Code/User
		return resolve(
			homeDir,
			"Library",
			"Application Support",
			"Code",
			"User",
		);
	}
	if (platform === "linux") {
		// Linux: ~/.config/Code/User
		return resolve(homeDir, ".config", "Code", "User");
	}
	if (platform === "win32") {
		// Windows: %APPDATA%\Code\User
		const appData = process.env.APPDATA;
		if (appData) {
			return resolve(appData, "Code", "User");
		}
	}

	return null;
}

/**
 * Checks if Claude CLI is installed
 */
async function isClaudeCLIInstalled(): Promise<boolean> {
	try {
		await execa("claude", ["--version"], {
			stdio: "ignore",
			timeout: 5000,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Detects which editors are installed on the system
 */
export async function detectAvailableEditors(
	homeDir: string,
): Promise<Editor[]> {
	const editors: Editor[] = [];

	// Check for Cursor (global config directory)
	const cursorDir = resolve(homeDir, ".cursor");
	if (existsSync(cursorDir)) {
		editors.push("Cursor");
	}

	// Check if VS Code's global config directory exists
	const vscodeGlobalDir = getVSCodeGlobalConfigDir(homeDir);
	if (vscodeGlobalDir && existsSync(vscodeGlobalDir)) {
		editors.push("VS Code");
	}

	// Check for Claude CLI by running the command
	const claudeInstalled = await isClaudeCLIInstalled();
	if (claudeInstalled) {
		editors.push("Claude CLI");
	}

	return editors;
}
