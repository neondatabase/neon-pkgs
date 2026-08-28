import { spawnSync } from "node:child_process";
import { execa } from "execa";

const TELEMETRY_BLOCKERS = ["DISABLE_TELEMETRY", "DO_NOT_TRACK"] as const;

export const PLUGIN_SOURCE = "neondatabase/agent-skills";
export const NEON_PLUGIN_NAME = "neon-postgres";
export const PLUGIN_SKILLS = [
	"neon",
	"neon-ai-gateway",
	"neon-functions",
	"neon-object-storage",
	"neon-postgres",
	"neon-postgres-branches",
	"neon-postgres-egress-optimizer",
] as const;
export const PLUGINS_CLI_TIMEOUT_MS = 120_000;

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
	global: boolean;
}): string => {
	const args = ["plugins"];
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
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<PluginsRunResult> => {
	const timeoutMs = options.timeoutMs ?? PLUGINS_CLI_TIMEOUT_MS;
	const subprocess = execa("npx", options.args, {
		cwd: options.cwd,
		env: pluginsChildEnv(options.env ?? process.env),
		// extendEnv would copy DISABLE_TELEMETRY / DO_NOT_TRACK back in.
		extendEnv: false,
		stdio: "pipe",
		// npx leaves the plugins CLI as a grandchild. execa's timeout signals
		// npx and then waits on the pipe, so a hang in the grandchild never
		// settles. A process-group kill reaps both. Detached disables execa's
		// parent-exit cleanup, so SIGINT/SIGTERM have to kill the tree too.
		detached: true,
	});
	let timedOut = false;
	let stopped = false;
	const stop = (): void => {
		if (stopped) {
			return;
		}
		stopped = true;
		if (subprocess.pid !== undefined) {
			killProcessTree(subprocess.pid);
		}
	};
	const onSigint = (): void => {
		stop();
		process.exit(130);
	};
	const onSigterm = (): void => {
		stop();
		process.exit(143);
	};
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	process.once("exit", stop);
	const timer = setTimeout(() => {
		timedOut = true;
		stop();
	}, timeoutMs);
	try {
		const result = await subprocess;
		return { stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		if (isCommandMissing(error)) {
			throw new Error(
				"neon plugins needs npx (Node.js) to run the plugins CLI. Install Node.js, then retry.",
			);
		}
		if (isExecaFailure(error)) {
			throw new Error(
				pluginsCliFailureMessage({
					stderr:
						typeof error.stderr === "string" ? error.stderr : "",
					stdout:
						typeof error.stdout === "string" ? error.stdout : "",
					timedOut,
					timeoutMs,
				}),
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigterm);
		process.removeListener("exit", stop);
	}
};

export const pluginsCliFailureMessage = (error: {
	stderr: string;
	stdout: string;
	timedOut?: boolean;
	timeoutMs?: number;
}): string => {
	const childOut = [error.stderr, error.stdout]
		.filter((part) => typeof part === "string" && part.length > 0)
		.join("\n");
	if (error.timedOut === true) {
		const seconds = Math.max(
			1,
			Math.ceil((error.timeoutMs ?? PLUGINS_CLI_TIMEOUT_MS) / 1000),
		);
		const unit = seconds === 1 ? "second" : "seconds";
		const headline = `plugins CLI timed out after ${seconds} ${unit}`;
		return childOut.length > 0
			? `${headline}:\n${childOut}`
			: `${headline}.`;
	}
	if (childOut.length > 0) {
		return `plugins CLI failed:\n${childOut}`;
	}
	return "plugins CLI failed.";
};

const killProcessTree = (pid: number): void => {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
		});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			return;
		}
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
	stderr: unknown;
	stdout: unknown;
	shortMessage: string;
} =>
	typeof error === "object" &&
	error !== null &&
	"shortMessage" in error &&
	typeof error.shortMessage === "string";
