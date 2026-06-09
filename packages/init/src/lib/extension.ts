import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { execa } from "execa";
import type { Editor } from "./types.js";
import { downloadVsix, NEON_EXTENSION_ID } from "./vsix.js";

/**
 * Uses macOS mdfind to locate an app by bundle identifier
 */
async function findAppWithMdfind(bundleId: string): Promise<string | null> {
	try {
		const result = await execa(
			"mdfind",
			[`kMDItemCFBundleIdentifier == '${bundleId}'`],
			{ timeout: 5000 },
		);
		const paths = result.stdout.trim().split("\n").filter(Boolean);
		return paths[0] || null;
	} catch {
		return null;
	}
}

/**
 * Known installation paths for VS Code CLI
 */
function getVSCodePaths(): string[] {
	const platform = process.platform;
	const home = process.env.HOME || "";

	if (platform === "darwin") {
		return [
			"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
			"/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
			`${home}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`,
			`${home}/Downloads/Visual Studio Code.app/Contents/Resources/app/bin/code`,
		];
	}

	if (platform === "linux") {
		return [
			"/usr/share/code/bin/code",
			"/usr/bin/code",
			"/snap/bin/code",
			"/usr/share/code-insiders/bin/code-insiders",
		];
	}

	if (platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA || "";
		const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
		return [
			`${localAppData}\\Programs\\Microsoft VS Code\\bin\\code.cmd`,
			`${programFiles}\\Microsoft VS Code\\bin\\code.cmd`,
			`${localAppData}\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd`,
		];
	}

	return [];
}

/**
 * Known installation paths for Cursor CLI
 */
function getCursorPaths(): string[] {
	const platform = process.platform;
	const home = process.env.HOME || "";

	if (platform === "darwin") {
		return [
			"/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
			`${home}/Applications/Cursor.app/Contents/Resources/app/bin/cursor`,
			`${home}/Downloads/Cursor.app/Contents/Resources/app/bin/cursor`,
		];
	}

	if (platform === "linux") {
		return [
			"/usr/share/cursor/bin/cursor",
			"/usr/bin/cursor",
			`${home}/.local/bin/cursor`,
			"/opt/cursor/bin/cursor",
		];
	}

	if (platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA || "";
		const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
		return [
			`${localAppData}\\Programs\\Cursor\\resources\\app\\bin\\cursor.cmd`,
			`${localAppData}\\cursor\\Cursor.exe`,
			`${programFiles}\\Cursor\\resources\\app\\bin\\cursor.cmd`,
		];
	}

	return [];
}

/**
 * Finds the CLI command for an editor by checking known installation paths
 * On macOS, also uses mdfind to locate the app if standard paths fail
 * Falls back to the simple command name if no full path is found (in case it's in PATH)
 */
export async function findEditorCommand(
	editor: Editor,
): Promise<string | null> {
	let paths: string[];
	let fallbackCommand: string;
	let bundleId: string | null = null;

	if (editor === "VS Code") {
		paths = getVSCodePaths();
		fallbackCommand = "code";
		bundleId = "com.microsoft.VSCode";
	} else if (editor === "Cursor") {
		paths = getCursorPaths();
		fallbackCommand = "cursor";
		bundleId = "com.todesktop.230313mzl4w4u92";
	} else {
		return null;
	}

	for (const path of paths) {
		if (existsSync(path)) {
			return path;
		}
	}

	// On macOS, try mdfind to locate the app dynamically
	if (process.platform === "darwin" && bundleId) {
		const appPath = await findAppWithMdfind(bundleId);
		if (appPath) {
			const cliPath = `${appPath}/Contents/Resources/app/bin/${fallbackCommand}`;
			if (existsSync(cliPath)) {
				return cliPath;
			}
		}
	}

	return fallbackCommand;
}

/**
 * Gets the URI scheme for an editor
 */
function getEditorUriScheme(editor: Editor): string | null {
	if (editor === "VS Code") {
		return "vscode";
	}
	if (editor === "Cursor") {
		return "cursor";
	}
	return null;
}

/**
 * Checks if the extension is installed by querying the editor's extension list
 */
export async function isExtensionInstalled(editor: Editor): Promise<boolean> {
	const command = await findEditorCommand(editor);
	if (!command) {
		return false;
	}

	try {
		const result = await execa(command, ["--list-extensions"], {
			timeout: 5000,
		});
		return result.stdout.includes(NEON_EXTENSION_ID);
	} catch {
		return false;
	}
}

/**
 * Waits for the extension to appear in the installed extensions list
 * This ensures the extension is fully installed and activated before we try to configure it
 */
export async function waitForExtensionInstalled(
	editor: Editor,
	maxAttempts = 10,
	delayMs = 1000,
): Promise<boolean> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const isInstalled = await isExtensionInstalled(editor);

		if (isInstalled) {
			// Give the extension a moment to fully activate and register URI handlers
			await new Promise((resolve) => setTimeout(resolve, 1000));
			return true;
		}

		// Wait before checking again (unless this is the last attempt)
		if (attempt < maxAttempts - 1) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	return false;
}

/**
 * Installs the Neon Local Connect extension for VS Code or Cursor.
 *
 * Strategy:
 * 1. Try `--install-extension <id>` directly (uses the editor's configured marketplace)
 * 2. If that fails, download .vsix (from proxy or Open VSX) and install locally
 * 3. Set NEON_VSX_GALLERY_URL to use a corporate proxy for the download
 */
export async function installExtension(editor: Editor): Promise<boolean> {
	const command = await findEditorCommand(editor);
	if (!command) {
		return false;
	}

	// Try direct marketplace install first
	try {
		await execa(command, ["--install-extension", NEON_EXTENSION_ID], {
			stdio: "pipe",
			timeout: 60000,
		});
		return true;
	} catch {
		// Fall through to VSIX download
	}

	// Download .vsix and install locally
	const vsixPath = await downloadVsix();
	if (!vsixPath) {
		return false;
	}

	try {
		await execa(command, ["--install-extension", vsixPath], {
			stdio: "pipe",
			timeout: 60000,
		});
		return true;
	} catch {
		return false;
	} finally {
		try {
			await unlink(vsixPath);
		} catch {}
	}
}

/**
 * Configures the Neon Local Connect extension with the API key
 * Uses the extension's URI handler to trigger the import-api-key command
 */
export async function configureExtension(
	editor: Editor,
	apiKey: string,
): Promise<boolean> {
	const scheme = getEditorUriScheme(editor);
	if (!scheme) {
		return false;
	}

	// Build the URI to trigger the extension's import-api-key handler
	// Format: vscode://databricks.neon-local-connect/import-api-key?token=xxx
	const encodedApiKey = encodeURIComponent(apiKey);
	const uri = `${scheme}://${NEON_EXTENSION_ID}/import-api-key?token=${encodedApiKey}`;

	try {
		const platform = process.platform;

		if (platform === "darwin") {
			// macOS: use 'open' command
			await execa("open", [uri], { timeout: 10000 });
		} else if (platform === "linux") {
			// Linux: use 'xdg-open' command
			await execa("xdg-open", [uri], { timeout: 10000 });
		} else if (platform === "win32") {
			// Windows: use 'start' command
			await execa("cmd", ["/c", "start", "", uri], { timeout: 10000 });
		} else {
			return false;
		}

		return true;
	} catch {
		return false;
	}
}

/**
 * Returns the editor types that should use extension installation (vs MCP)
 */
export function usesExtension(editor: Editor): boolean {
	return editor === "VS Code" || editor === "Cursor";
}
