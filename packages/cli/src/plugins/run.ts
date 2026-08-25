import { execa } from "execa";

const TELEMETRY_BLOCKERS = ["DISABLE_TELEMETRY", "DO_NOT_TRACK"] as const;

export const PLUGIN_SOURCE = "neondatabase/agent-skills";
export const NEON_PLUGIN_NAME = "neon-postgres";

export type PluginsCliScope = "user" | "project";

export const pluginsChildEnv = (
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
	const env = { ...base };
	// The plugins CLI needs its own install ping even though Neon records the parent command.
	for (const key of TELEMETRY_BLOCKERS) {
		delete env[key];
	}
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === "NEON_API_KEY") {
			delete env[key];
		}
	}
	return env;
};

export const pluginsScopeFlag = (global: boolean): PluginsCliScope =>
	global ? "user" : "project";

export const pluginsAddArgs = (options: {
	target: string;
	global: boolean;
}): string[] => {
	if (options.target.length === 0) {
		throw new Error("plugins add needs a -t target.");
	}
	return [
		"-y",
		"plugins",
		"add",
		PLUGIN_SOURCE,
		"-t",
		options.target,
		"-s",
		pluginsScopeFlag(options.global),
		"-y",
	];
};

export const neonPluginsRetryCommand = (options: {
	agents: readonly string[];
	global: boolean;
}): string => {
	const args = ["plugins"];
	for (const agent of options.agents) {
		args.push("--agent", agent);
	}
	if (options.global) {
		args.push("--global");
	}
	args.push("-y");
	return `neon ${args.map(quoteNpxArg).join(" ")}`;
};

export const quoteNpxArg = (part: string): string =>
	/[\s"'\\*]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part;

export type PluginsRunResult = {
	stdout: string;
	stderr: string;
};

export const runPluginsCli = async (options: {
	args: readonly string[];
	cwd: string;
}): Promise<PluginsRunResult> => {
	try {
		const result = await execa("npx", options.args, {
			cwd: options.cwd,
			env: pluginsChildEnv(),
			// extendEnv would copy DISABLE_TELEMETRY / DO_NOT_TRACK back in.
			extendEnv: false,
			stdio: "pipe",
			timeout: 120_000,
		});
		return { stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		if (isCommandMissing(error)) {
			throw new Error(
				"neon plugins needs npx (Node.js) to run the plugins CLI. Install Node.js, then retry.",
			);
		}
		if (isExecaFailure(error)) {
			const childOut = [error.stderr, error.stdout]
				.filter((part) => typeof part === "string" && part.length > 0)
				.join("\n");
			if (childOut.length > 0) {
				throw new Error(`plugins CLI failed:\n${childOut}`);
			}
			throw new Error("plugins CLI failed.");
		}
		throw error;
	}
};

const isCommandMissing = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === "ENOENT";

const isExecaFailure = (
	error: unknown,
): error is {
	stderr: string;
	stdout: string;
	shortMessage: string;
} =>
	typeof error === "object" &&
	error !== null &&
	"shortMessage" in error &&
	typeof error.shortMessage === "string";
