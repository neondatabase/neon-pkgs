import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { recordLatestVersion } from "./update_notifier.js";

const execFileAsync = promisify(execFile);
const LOOKUP_TIMEOUT_MS = 5000;

export const npmViewInvocation = (
	platform: NodeJS.Platform,
): { args: string[]; command: string; shell: boolean } => ({
	args: ["view", "neon", "version", "--json"],
	command: platform === "win32" ? "npm.cmd" : "npm",
	shell: platform === "win32",
});

const npmLatestVersion = async (): Promise<string | undefined> => {
	const invocation = npmViewInvocation(process.platform);
	const { stdout } = await execFileAsync(
		invocation.command,
		invocation.args,
		{
			encoding: "utf8",
			shell: invocation.shell,
			timeout: LOOKUP_TIMEOUT_MS,
			windowsHide: true,
		},
	);
	const value: unknown = JSON.parse(stdout);
	return typeof value === "string" ? value : undefined;
};

const homebrewLatestVersion = async (): Promise<string | undefined> => {
	const response = await fetch(
		"https://formulae.brew.sh/api/formula/neonctl.json",
		{ signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
	);
	if (!response.ok) return undefined;

	const value: unknown = await response.json();
	if (
		typeof value !== "object" ||
		value === null ||
		!("versions" in value) ||
		typeof value.versions !== "object" ||
		value.versions === null ||
		!("stable" in value.versions) ||
		typeof value.versions.stable !== "string"
	) {
		return undefined;
	}
	return value.versions.stable;
};

const run = async (): Promise<void> => {
	const [cachePath, source] = process.argv.slice(2);
	if (
		cachePath === undefined ||
		(source !== "homebrew" && source !== "npm")
	) {
		return;
	}

	try {
		const latestVersion =
			source === "homebrew"
				? await homebrewLatestVersion()
				: await npmLatestVersion();
		if (latestVersion !== undefined) {
			recordLatestVersion(cachePath, latestVersion);
		}
	} catch {
		// Update checks are advisory and must not affect the command that launched them.
	}
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	void run();
}
