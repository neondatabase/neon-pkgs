import { resolve } from "node:path";
import { type AgentType, detectInstalledAgents } from "./agents.js";

export function getVSCodeGlobalConfigDir(homeDir: string): string | null {
	const platform = process.platform;

	if (platform === "darwin") {
		return resolve(
			homeDir,
			"Library",
			"Application Support",
			"Code",
			"User",
		);
	}
	if (platform === "linux") {
		return resolve(homeDir, ".config", "Code", "User");
	}
	if (platform === "win32") {
		const appData = process.env.APPDATA;
		if (appData) {
			return resolve(appData, "Code", "User");
		}
	}

	return null;
}

export async function detectAvailableEditors(
	_homeDir?: string,
): Promise<AgentType[]> {
	return detectInstalledAgents();
}
