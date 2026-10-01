import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type ModuleLog, moduleIdentity } from "./budget.js";

const here = dirname(fileURLToPath(import.meta.url));
export const CLI_PACKAGE_ROOT = join(here, "..", "..");
export const CLI_ENTRY = join(CLI_PACKAGE_ROOT, "dist", "cli.js");
export const BUDGETS_PATH = join(CLI_PACKAGE_ROOT, "perf-budgets.json");
const MODULE_HOOK = join(here, "module-hook.mjs");

export type Scenario = {
	/** The argv as typed after `neon`; also the scenario's key in `perf-budgets.json`. */
	name: string;
	argv: string[];
	/** Talks to the Neon API, so it runs against the mock server with a fake key. */
	api?: boolean;
	/** Runs from a directory linked with a `.neon` file. */
	linked?: boolean;
	expect: { code: number; stdout?: RegExp; stderr?: RegExp };
};

export const SCENARIOS: Scenario[] = [
	{
		name: "--version",
		argv: ["--version"],
		expect: { code: 0, stdout: /^\d+\.\d+\.\d+/ },
	},
	{
		name: "--help",
		argv: ["--help"],
		expect: { code: 0, stdout: /neon projects/ },
	},
	{
		// The exact invocation `current_branch_fast_path.ts` serves; any extra flag bypasses it.
		name: "status --current-branch",
		argv: ["status", "--current-branch"],
		linked: true,
		expect: { code: 0, stdout: /^main$/m },
	},
	{
		name: "projects list --help",
		argv: ["projects", "list", "--help"],
		expect: { code: 0, stdout: /List projects/ },
	},
	{
		name: "projects not-a-command",
		argv: ["projects", "not-a-command"],
		expect: { code: 1, stderr: /ERROR: Unknown command: not-a-command/ },
	},
	{
		name: "projects list",
		argv: ["projects", "list"],
		api: true,
		expect: { code: 0, stdout: /"id"/ },
	},
	{
		name: "branches list --project-id test",
		argv: ["branches", "list", "--project-id", "test"],
		api: true,
		expect: { code: 0, stdout: /"id"/ },
	},
];

export type Sandbox = {
	/** HOME, and the working directory of unlinked scenarios. */
	home: string;
	/** A directory under `home` holding a `.neon` that pins the `main` branch. */
	linked: string;
	env: NodeJS.ProcessEnv;
	cleanup: () => void;
};

/**
 * A HOME and working directory nothing on this machine has touched, with an environment that
 * carries over only PATH, so stored credentials, profiles, `NEON_*` variables, and
 * `NODE_OPTIONS` instrumentation can't change what a scenario loads or requests.
 */
export const createSandbox = (apiHost?: string): Sandbox => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "neon-perf-")));
	const linked = join(home, "linked");
	mkdirSync(linked);
	writeFileSync(
		join(linked, ".neon"),
		JSON.stringify({ projectId: "test", branch: "main" }),
	);
	return {
		home,
		linked,
		env: {
			PATH: process.env.PATH,
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			CI: "true",
			NO_COLOR: "1",
			...(apiHost ? { NEON_API_HOST: apiHost } : {}),
		},
		cleanup: () => rmSync(home, { recursive: true, force: true }),
	};
};

/** Why a run doesn't count as the scenario succeeding, or undefined when it does. */
export const scenarioOutputMismatch = (
	scenario: Scenario,
	run: CliRun,
): string | undefined => {
	const problems = [
		run.code !== scenario.expect.code &&
			`exited ${run.code}, expected ${scenario.expect.code}`,
		scenario.expect.stdout &&
			!scenario.expect.stdout.test(run.stdout) &&
			`stdout does not match ${scenario.expect.stdout}`,
		scenario.expect.stderr &&
			!scenario.expect.stderr.test(run.stderr) &&
			`stderr does not match ${scenario.expect.stderr}`,
	].filter((problem): problem is string => typeof problem === "string");
	return problems.length > 0
		? `neon ${scenario.name}: ${problems.join("; ")}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`
		: undefined;
};

/** Flags appended to every scenario except the linked fast path, which only serves its exact argv. */
export const scenarioArgv = (
	scenario: Scenario,
	apiHost: string | undefined,
): string[] => {
	if (scenario.linked) {
		return scenario.argv;
	}
	const api = scenario.api
		? [
				"--api-host",
				requireApiHost(apiHost),
				"--api-key",
				"test-key",
				"--output",
				"json",
			]
		: [];
	return [...scenario.argv, "--no-analytics", ...api];
};

const requireApiHost = (apiHost: string | undefined): string => {
	if (!apiHost) {
		throw new Error("API scenarios need the mock server's URL");
	}
	return apiHost;
};

export type CliRun = { code: number | null; stdout: string; stderr: string };

export const runCli = (input: {
	cli: string;
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	nodeArgs?: string[];
	timeoutMs?: number;
}): Promise<CliRun> =>
	new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[...(input.nodeArgs ?? []), input.cli, ...input.argv],
			{
				cwd: input.cwd,
				env: input.env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`neon ${input.argv.join(" ")} did not exit within ${input.timeoutMs ?? 15_000}ms\nstderr: ${stderr}`,
				),
			);
		}, input.timeoutMs ?? 15_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});

/** Run the CLI with `module-hook.mjs` preloaded and return its run plus the module log. */
export const runCliWithModuleLog = async (input: {
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	logDir: string;
}): Promise<{ run: CliRun; log: ModuleLog }> => {
	const logPath = join(
		input.logDir,
		`modules-${Date.now()}-${Math.random()}.json`,
	);
	const run = await runCli({
		cli: CLI_ENTRY,
		argv: input.argv,
		cwd: input.cwd,
		env: { ...input.env, NEON_PERF_MODULE_LOG: logPath },
		nodeArgs: ["--import", MODULE_HOOK],
	});
	if (!existsSync(logPath)) {
		throw new Error(
			`module-hook.mjs wrote no log for neon ${input.argv.join(" ")}\nstderr: ${run.stderr}`,
		);
	}
	const log: ModuleLog = JSON.parse(readFileSync(logPath, "utf8"));
	return { run, log };
};

/** Maps a loaded file URL to its stable identity, reading each package.json once. */
export const createIdentifier = (): ((url: string) => string) => {
	const cliName: string = JSON.parse(
		readFileSync(join(CLI_PACKAGE_ROOT, "package.json"), "utf8"),
	).name;
	const packageByDir = new Map<string, { name: string; root: string }>();

	const nearestNamedPackage = (
		dir: string,
	): { name: string; root: string } => {
		const cached = packageByDir.get(dir);
		if (cached) {
			return cached;
		}
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const name: unknown = JSON.parse(
				readFileSync(manifest, "utf8"),
			).name;
			if (typeof name === "string") {
				const found = { name, root: dir };
				packageByDir.set(dir, found);
				return found;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(`no package.json with a name above ${dir}`);
		}
		const found = nearestNamedPackage(parent);
		packageByDir.set(dir, found);
		return found;
	};

	return (url) => {
		const path = fileURLToPath(url);
		const pkg = nearestNamedPackage(dirname(path));
		return moduleIdentity(
			{
				name: pkg.name,
				relativePath: relative(pkg.root, path).split(sep).join("/"),
				// Workspace packages resolve through their symlink to the real path in this repo.
				workspace: !pkg.root.split(sep).includes("node_modules"),
			},
			cliName,
		);
	};
};
