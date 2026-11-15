import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { execa } from "execa";
import prompts from "prompts";
import which from "which";
import { readEnvFile } from "../env_file.js";
import { getSkillsAgentName } from "../init/agents.js";
import { log } from "../log.js";
import {
	type AgentType,
	agentSupportsProjectMcp,
	agentSupportsTransport,
	getAgentDisplayName,
	uniqueAgentIds,
} from "../mcp/agents.js";
import {
	projectMcpConfigPath,
	projectMcpServerExists,
	protectProjectMcpConfig,
	trackedProjectMcpConfig,
} from "../mcp/install.js";
import { versionAtLeast } from "../plugins/targets.js";
import {
	runSkillsCli,
	skillsAddArgs,
	skillsChildEnv,
	skillsMetadata,
} from "../skills/run.js";
import {
	type CommandResult,
	globalInstallCommand,
	runCommandWithDetail,
} from "../utils/package_manager.js";
import { writer } from "../writer.js";
import {
	isSafeText,
	mcpPlaceholders,
	shellQuote,
	shellWordWithPlaceholders,
	substitutePlaceholders,
	type TemplateAgentTooling,
	type TemplateCli,
	type TemplateMcpServer,
	type TemplateNpmCli,
	type TemplateSkills,
	type TemplateSystemCli,
} from "./agent_tooling.js";

/** Kept equal to the `add-mcp` dependency by `agent_tooling_run.test.ts`. */
export const ADD_MCP_PACKAGE = "add-mcp@2.6.0";
const SKILLS_PACKAGE = "skills@latest";
const CHILD_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 10_000;

/**
 * `neon` for templates Neon publishes, `third-party` for anything that loads from someone
 * else's repository. Third-party tooling is never installed without the user opting in, and
 * its `${NAME}` placeholders are only ever filled from a prompt.
 */
export type TemplateToolingTrust = "neon" | "third-party";

export type TemplateToolingEntry =
	| { kind: "skills"; item: TemplateSkills }
	| { kind: "mcp"; item: TemplateMcpServer }
	| { kind: "cli"; item: TemplateCli };

export type TemplateToolingRow = {
	kind: "skills" | "mcp" | "cli";
	name: string;
	agents: string;
	status: "installed" | "found" | "skipped" | "failed";
	detail?: string;
};

export type TemplateToolingReport = {
	rows: TemplateToolingRow[];
	/** Commands that finish what this run skipped or could not do. */
	next: string[];
};

export type TemplateToolingOperations = {
	runSkills: (options: {
		args: readonly string[];
		cwd: string;
		env: NodeJS.ProcessEnv;
	}) => Promise<unknown>;
	runAddMcp: (options: {
		args: readonly string[];
		cwd: string;
		env: NodeJS.ProcessEnv;
	}) => Promise<CommandResult>;
	/** The global install command for an npm package, or undefined when no manager can do one. */
	globalInstall: (
		pkg: string,
	) => { command: string; args: string[] } | undefined;
	install: (
		command: string,
		args: string[],
		cwd: string,
	) => Promise<CommandResult>;
	probe: (name: string, cwd: string) => CliProbe;
	askSecret: (message: string) => Promise<string | undefined>;
	pick: (
		entries: readonly TemplateToolingEntry[],
		selected: readonly boolean[],
	) => Promise<TemplateToolingEntry[] | undefined>;
};

export type CliProbe =
	| { found: false }
	| { found: true; version?: string; detail?: string };

export const templateToolingEntries = (
	tooling: TemplateAgentTooling,
): TemplateToolingEntry[] => [
	...tooling.skills.map((item) => ({ kind: "skills" as const, item })),
	...tooling.mcp.map((item) => ({ kind: "mcp" as const, item })),
	...tooling.cli.map((item) => ({ kind: "cli" as const, item })),
];

const entryName = (entry: TemplateToolingEntry): string =>
	entry.kind === "skills"
		? `${entry.item.skills.join(", ")} from ${entry.item.source}`
		: entry.item.name;

/** Exactly what selecting an entry runs or writes, so a consent prompt hides nothing. */
export const describeTemplateToolingEntry = (
	entry: TemplateToolingEntry,
): string => {
	switch (entry.kind) {
		case "skills":
			return `Skills, installed with npx ${SKILLS_PACKAGE} add ${entry.item.source}`;
		case "mcp": {
			const server = entry.item;
			const what =
				server.kind === "remote"
					? `MCP server at ${server.url}`
					: `MCP server that runs \`${server.command.join(" ")}\``;
			const reads = mcpPlaceholders(server);
			return [
				what,
				reads.length > 0 ? `needs ${reads.join(", ")}` : undefined,
				server.description,
			]
				.filter(Boolean)
				.join(". ");
		}
		case "cli": {
			const cli = entry.item;
			const what =
				cli.kind === "npm"
					? `CLI, installs ${cli.package} globally with npm install -g unless \`${cli.name}\` is on PATH`
					: `CLI, checks \`${cli.name}\` is on PATH${cli.minVersion ? ` at ${cli.minVersion} or newer` : ""}`;
			return [what, cli.description].filter(Boolean).join(". ");
		}
		default: {
			const _exhaustive: never = entry;
			return _exhaustive;
		}
	}
};

const PICK_MESSAGES: Record<TemplateToolingEntry["kind"], string> = {
	skills: "Which skills should your coding agents get?",
	mcp: "Which MCP servers should your coding agents get?",
	cli: "Which CLIs should be installed?",
};

/** One multiselect per kind, so each can be taken whole, in part, or not at all. */
const pickEntries: TemplateToolingOperations["pick"] = async (
	entries,
	selected,
) => {
	const chosen = new Set<number>();
	for (const kind of ["skills", "mcp", "cli"] as const) {
		const indexes = entries.flatMap((entry, index) =>
			entry.kind === kind ? [index] : [],
		);
		if (indexes.length === 0) continue;
		const answer = await prompts({
			type: "multiselect",
			name: "value",
			message: PICK_MESSAGES[kind],
			hint: "Space to toggle, a to toggle all, Enter to confirm.",
			choices: indexes.map((index) => {
				const entry = entries[index] as TemplateToolingEntry;
				return {
					title: entryName(entry),
					description: describeTemplateToolingEntry(entry),
					value: index,
					selected: selected[index] === true,
				};
			}),
			instructions: false,
		});
		if (!Array.isArray(answer.value)) return undefined;
		for (const index of answer.value as number[]) chosen.add(index);
	}
	return entries.filter((_entry, index) => chosen.has(index));
};

/** One entry per skill, so the picker offers each skill on its own. */
const splitSkills = (
	entries: readonly TemplateToolingEntry[],
): TemplateToolingEntry[] =>
	entries.flatMap((entry): TemplateToolingEntry[] =>
		entry.kind === "skills"
			? entry.item.skills.map((skill) => ({
					kind: "skills",
					item: { ...entry.item, skills: [skill] },
				}))
			: [entry],
	);

/** Back to one entry per source, so each source is still a single skills CLI run. */
const joinSkills = (
	entries: readonly TemplateToolingEntry[],
): TemplateToolingEntry[] => {
	const bySource = new Map<string, TemplateSkills>();
	const joined: TemplateToolingEntry[] = [];
	for (const entry of entries) {
		if (entry.kind !== "skills") {
			joined.push(entry);
			continue;
		}
		const existing = bySource.get(entry.item.source);
		if (existing) {
			existing.skills.push(...entry.item.skills);
			continue;
		}
		const item = { ...entry.item, skills: [...entry.item.skills] };
		bySource.set(item.source, item);
		joined.push({ kind: "skills", item });
	}
	return joined;
};

const askSecret: TemplateToolingOperations["askSecret"] = async (message) => {
	const answer = await prompts({
		type: "password",
		name: "value",
		message,
	});
	return typeof answer.value === "string" ? answer.value : undefined;
};

export type SelectTemplateToolingOptions = {
	tooling: TemplateAgentTooling;
	trust: TemplateToolingTrust;
	/** Where the template comes from, for messages: `owner/repo`. */
	origin: string;
	/** `--template-tooling`: true installs the recommended entries without asking, false installs none. */
	flag?: boolean;
	yes: boolean;
	interactive: boolean;
	pick?: TemplateToolingOperations["pick"];
};

/**
 * Which entries to install. A terminal asks, preselecting the recommended ones only for
 * Neon's own templates. `-y` installs Neon's recommended entries and skips a third-party
 * template's, which only an explicit `--template-tooling` installs unattended.
 */
export const selectTemplateTooling = async (
	options: SelectTemplateToolingOptions,
): Promise<TemplateToolingEntry[]> => {
	const entries = templateToolingEntries(options.tooling);
	if (options.flag === false || entries.length === 0) return [];
	const recommended = entries.filter((entry) => entry.item.recommended);
	if (options.flag === true) return recommended;
	if (options.interactive) {
		if (options.trust === "third-party") {
			log.warning(
				"The template from %s suggests agent tooling. Neon has not reviewed it, so nothing is selected; pick only what you trust.",
				options.origin,
			);
		}
		const choices = splitSkills(entries);
		const picked = await (options.pick ?? pickEntries)(
			choices,
			choices.map(
				(entry) => options.trust === "neon" && entry.item.recommended,
			),
		);
		return joinSkills(picked ?? []);
	}
	if (recommended.length === 0) return [];
	if (options.yes && options.trust === "neon") return recommended;
	log.info(
		options.trust === "third-party"
			? "Skipped the agent tooling suggested by %s: it is not from Neon. Pass --template-tooling to install it."
			: "Skipped the agent tooling this template suggests (%s). Pass --template-tooling to install it.",
		options.trust === "third-party"
			? options.origin
			: recommended.map(entryName).join("; "),
	);
	return [];
};

/**
 * The environment for the skills and add-mcp children. Neither needs a credential, and
 * `GIT_TERMINAL_PROMPT=0` stops git from waiting on a terminal prompt for a private source.
 */
export const templateToolingChildEnv = (
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
	const env = skillsChildEnv(base);
	for (const key of Object.keys(env)) {
		if (key.toUpperCase().startsWith("NEON_")) {
			delete env[key];
		}
	}
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
};

/**
 * The installed `add-mcp` dependency's bin, when it is the pinned version. npx spends
 * most of a second resolving the package before it runs. A packaged binary cannot
 * spawn a script from its snapshot, so it keeps using npx.
 */
const installedAddMcpBin = (): string | undefined => {
	if ("pkg" in process) return undefined;
	try {
		const manifestPath = createRequire(import.meta.url).resolve(
			"add-mcp/package.json",
		);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			version?: unknown;
			bin?: unknown;
		};
		if (`add-mcp@${String(manifest.version)}` !== ADD_MCP_PACKAGE) {
			return undefined;
		}
		const bin =
			typeof manifest.bin === "string"
				? manifest.bin
				: (manifest.bin as Record<string, unknown> | undefined)?.[
						"add-mcp"
					];
		if (typeof bin !== "string") return undefined;
		const path = join(dirname(manifestPath), bin);
		return existsSync(path) ? path : undefined;
	} catch {
		return undefined;
	}
};

/** `npx -y add-mcp@<pinned> …` as the command and argv that run it. */
export const addMcpCommand = (
	args: readonly string[],
	resolveBin: () => string | undefined = installedAddMcpBin,
): { file: string; args: readonly string[] } => {
	const bin =
		args[0] === "-y" && args[1] === ADD_MCP_PACKAGE
			? resolveBin()
			: undefined;
	return bin === undefined
		? { file: "npx", args }
		: { file: process.execPath, args: [bin, ...args.slice(2)] };
};

const runAddMcp: TemplateToolingOperations["runAddMcp"] = async (options) => {
	try {
		const command = addMcpCommand(options.args);
		await execa(command.file, command.args, {
			cwd: options.cwd,
			env: options.env,
			extendEnv: false,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: CHILD_TIMEOUT_MS,
		});
		return { ok: true };
	} catch (error) {
		const record = (error ?? {}) as {
			code?: unknown;
			stderr?: unknown;
			stdout?: unknown;
			shortMessage?: unknown;
		};
		if (record.code === "ENOENT") {
			return { ok: false, detail: "npx (Node.js) is not installed" };
		}
		const output = [record.stderr, record.stdout]
			.filter(
				(part): part is string =>
					typeof part === "string" && part.trim() !== "",
			)
			.join("\n");
		return {
			ok: false,
			detail:
				output ||
				(typeof record.shortMessage === "string"
					? record.shortMessage
					: String(error)),
		};
	}
};

const probeCli = (name: string, cwd: string): CliProbe => {
	const resolved = which.sync(name, { nothrow: true });
	if (resolved === null) return { found: false };
	const result = spawnSync(resolved, ["--version"], {
		cwd,
		env: templateToolingChildEnv(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: VERSION_TIMEOUT_MS,
		windowsHide: true,
	});
	if (result.error !== undefined || result.status !== 0) {
		return { found: true, detail: `\`${name} --version\` failed` };
	}
	const version = `${result.stdout}\n${result.stderr}`.match(
		/\d+\.\d+\.\d+/,
	)?.[0];
	return version === undefined ? { found: true } : { found: true, version };
};

const defaultOperations: TemplateToolingOperations = {
	runSkills: (options) => runSkillsCli(options),
	runAddMcp,
	globalInstall: (pkg) => globalInstallCommand("npm", pkg),
	install: runCommandWithDetail,
	probe: probeCli,
	askSecret,
	pick: pickEntries,
};

export type RunTemplateToolingOptions = {
	entries: readonly TemplateToolingEntry[];
	trust: TemplateToolingTrust;
	/** The project the tooling is for: skills and MCP configs land here. */
	cwd: string;
	agents: readonly AgentType[];
	interactive: boolean;
	/**
	 * Whether the user agreed to global installs, by picking npm CLIs in a terminal or passing
	 * `--template-tooling`. A bare `-y` changes nothing outside the project, so it leaves npm
	 * CLIs in next steps.
	 */
	installGlobal: boolean;
	/** A dotenv file Neon templates may fill `${NAME}` from. Third-party templates never read it. */
	envFile?: string;
	env?: NodeJS.ProcessEnv;
	operations?: Partial<TemplateToolingOperations>;
};

const firstLine = (text: string): string =>
	text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "") ?? "";

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const redact = (text: string, secrets: readonly string[]): string =>
	secrets
		.filter((secret) => secret.length > 0)
		.reduce((out, secret) => out.split(secret).join("[redacted]"), text);

const displayAgents = (agents: readonly AgentType[]): string =>
	agents.map(getAgentDisplayName).join(", ");

/**
 * Placeholder names a Neon template may not fill from the environment or `.env`. A typo
 * or a compromised manifest must not copy a cloud or Neon credential into an MCP config
 * that a third-party server receives on every request; such a value is always asked for.
 */
const AMBIENT_DENIED =
	/^(?:NEON_|AWS_|AZURE_|GOOGLE_|GCP_|GCLOUD_|GH_|GITHUB_|GITLAB_|NPM_|SSH_|PG|DATABASE_URL$|NODE_AUTH_TOKEN$)/;

const skillsRetry = (entry: TemplateSkills, agents: readonly string[]) =>
	[
		"npx",
		"-y",
		SKILLS_PACKAGE,
		"add",
		entry.source,
		...entry.skills.flatMap((skill) => ["--skill", skill]),
		...agents.flatMap((agent) => ["--agent", agent]),
		...(agents.length > 0 ? ["-y"] : []),
	]
		.map(shellQuote)
		.join(" ");

/** add-mcp argv for `server`; `value` fills each header or env value. */
export const addMcpArgs = (
	server: TemplateMcpServer,
	agents: readonly AgentType[],
	value: (raw: string) => string,
): string[] => {
	const args = ["-y", ADD_MCP_PACKAGE];
	if (server.kind === "remote") {
		args.push(server.url, "--name", server.name, "-t", server.transport);
	} else {
		// add-mcp splits a target on spaces, so only the executable and one space-free
		// argument go there; every other argument passes through --args verbatim.
		const [executable, first, ...rest] = server.command;
		args.push(`${executable} ${first}`, "--name", server.name);
		for (const part of rest) {
			args.push("--args", part);
		}
	}
	for (const agent of agents) {
		args.push("-a", agent);
	}
	if (server.kind === "remote") {
		for (const [name, raw] of Object.entries(server.headers)) {
			args.push("--header", `${name}: ${value(raw)}`);
		}
	} else {
		for (const [name, raw] of Object.entries(server.env)) {
			args.push("--env", `${name}=${value(raw)}`);
		}
	}
	args.push("-y");
	return args;
};

/** The command a user can run for `server`; secrets stay `"$NAME"` for their shell. */
export const addMcpRetry = (
	server: TemplateMcpServer,
	agents: readonly AgentType[],
): string =>
	[
		"npx",
		...addMcpArgs(server, agents, (raw) => raw).map(
			shellWordWithPlaceholders,
		),
	].join(" ");

/** Install hints, this platform's package manager first. Printed, never run. */
export const systemCliHint = (
	cli: TemplateSystemCli,
	platform: NodeJS.Platform = process.platform,
): string => {
	const { brew, winget, url } = cli.install;
	const brewHint = brew ? [`brew install ${shellQuote(brew)}`] : [];
	const wingetHint = winget
		? [`winget install --id ${shellQuote(winget)} -e`]
		: [];
	return [
		...(platform === "win32"
			? [...wingetHint, ...brewHint]
			: [...brewHint, ...wingetHint]),
		...(url ? [url] : []),
	].join(" or ");
};

const hasOwn = (record: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(record, key);

/**
 * Installs the selected entries. Never throws for an entry: each one becomes a row, and
 * whatever did not finish becomes a command in `next`.
 */
export const runTemplateTooling = async (
	options: RunTemplateToolingOptions,
): Promise<TemplateToolingReport> => {
	const ops: TemplateToolingOperations = {
		...defaultOperations,
		...options.operations,
	};
	const rows: TemplateToolingRow[] = [];
	const next: string[] = [];
	const agents = uniqueAgentIds(options.agents);
	const childEnv = templateToolingChildEnv(options.env);

	const skills = options.entries.flatMap((entry) =>
		entry.kind === "skills" ? [entry.item] : [],
	);
	const skillsAgents = [
		...new Set(agents.flatMap((agent) => getSkillsAgentName(agent) ?? [])),
	];
	for (const entry of skills) {
		const row = {
			kind: "skills" as const,
			name: entryName({ kind: "skills", item: entry }),
			agents: skillsAgents.join(", "),
		};
		if (skillsAgents.length === 0) {
			rows.push({ ...row, status: "skipped", detail: "no coding agent" });
			next.push(skillsRetry(entry, []));
			continue;
		}
		try {
			await ops.runSkills({
				args: skillsAddArgs({
					source: entry.source,
					skills: entry.skills,
					agents: skillsAgents,
					global: false,
					metadata: skillsMetadata("template"),
				}),
				cwd: options.cwd,
				env: childEnv,
			});
			rows.push({ ...row, status: "installed" });
		} catch (error) {
			rows.push({
				...row,
				status: "failed",
				detail: firstLine(errorText(error)).slice(0, 200),
			});
			next.push(skillsRetry(entry, skillsAgents));
		}
	}

	const servers = options.entries.flatMap((entry) =>
		entry.kind === "mcp" ? [entry.item] : [],
	);
	let dotenv: Record<string, string> | undefined;
	const readDotenv = (): Record<string, string> => {
		if (dotenv !== undefined) return dotenv;
		dotenv = {};
		if (options.envFile && existsSync(options.envFile)) {
			try {
				dotenv = readEnvFile(options.envFile);
			} catch (error) {
				log.debug(
					"Could not read %s: %s",
					options.envFile,
					errorText(error),
				);
			}
		}
		return dotenv;
	};
	const ambient = (name: string): string | undefined => {
		if (options.trust !== "neon" || AMBIENT_DENIED.test(name)) {
			return undefined;
		}
		const env = options.env ?? process.env;
		const value = hasOwn(env, name) ? env[name] : undefined;
		if (value !== undefined && value !== "") return value;
		const fromFile = readDotenv();
		return hasOwn(fromFile, name) ? fromFile[name] : undefined;
	};
	for (const server of servers) {
		const row = { kind: "mcp" as const, name: server.name };
		const transport = server.kind === "remote" ? server.transport : "stdio";
		const capable = agents.filter(
			(agent) =>
				agentSupportsProjectMcp(agent) &&
				agentSupportsTransport(agent, transport),
		);
		const existing = capable.filter((agent) =>
			projectMcpServerExists({
				agent,
				name: server.name,
				cwd: options.cwd,
				selected: capable,
			}),
		);
		if (existing.length > 0) {
			log.warning(
				"%s already has an MCP server named %s; left it unchanged.",
				displayAgents(existing),
				server.name,
			);
		}
		let eligible = capable.filter((agent) => !existing.includes(agent));
		if (eligible.length === 0) {
			rows.push({
				...row,
				agents: displayAgents(existing),
				status: "skipped",
				detail:
					existing.length > 0
						? "already configured"
						: agents.length === 0
							? "no coding agent"
							: `no selected agent takes a project-level ${transport} MCP server`,
			});
			if (agents.length === 0) next.push(addMcpRetry(server, []));
			continue;
		}

		const names = mcpPlaceholders(server);
		const values: Record<string, string> = Object.create(null);
		const missing: string[] = [];
		for (const name of names) {
			let value = ambient(name);
			if (value === undefined && options.interactive) {
				const where =
					server.kind === "remote"
						? new URL(server.url).host
						: (server.command[0] ?? server.name);
				value = await ops.askSecret(
					`${name} for the ${server.name} MCP server (${where}); leave empty to skip`,
				);
			}
			if (value === undefined || value === "" || !isSafeText(value)) {
				missing.push(name);
			} else {
				values[name] = value;
			}
		}
		if (missing.length > 0) {
			rows.push({
				...row,
				agents: displayAgents(eligible),
				status: "skipped",
				detail: `needs ${missing.join(", ")}`,
			});
			next.push(
				`Set ${missing.join(", ")}, then run: ${addMcpRetry(server, eligible)}`,
			);
			continue;
		}

		const secrets = Object.values(values);
		if (names.length > 0) {
			const tracked = eligible.flatMap((agent) => {
				const path = trackedProjectMcpConfig({
					agents: [agent],
					cwd: options.cwd,
				});
				return path === undefined ? [] : [{ agent, path }];
			});
			for (const { path } of tracked) {
				log.warning(
					"%s is tracked by git, so the %s MCP server would commit %s. Untrack it, then run the command in Next.",
					path,
					server.name,
					names.join(", "),
				);
			}
			if (tracked.length > 0) {
				next.push(
					addMcpRetry(
						server,
						tracked.map(({ agent }) => agent),
					),
				);
				eligible = eligible.filter(
					(agent) => !tracked.some((entry) => entry.agent === agent),
				);
			}
			if (eligible.length === 0) {
				rows.push({
					...row,
					agents: displayAgents(tracked.map(({ agent }) => agent)),
					status: "skipped",
					detail: "config tracked by git",
				});
				continue;
			}
		}

		const result = await ops.runAddMcp({
			args: addMcpArgs(server, eligible, (raw) =>
				substitutePlaceholders(raw, values),
			),
			cwd: options.cwd,
			env: childEnv,
		});
		if (!result.ok) {
			rows.push({
				...row,
				agents: displayAgents(eligible),
				status: "failed",
				detail: firstLine(redact(result.detail, secrets)).slice(0, 200),
			});
			next.push(addMcpRetry(server, eligible));
			continue;
		}
		if (names.length > 0) {
			for (const agent of eligible) {
				const path = projectMcpConfigPath({
					agent,
					cwd: options.cwd,
					selected: eligible,
				});
				if (path === undefined || !existsSync(path)) continue;
				const problem = protectProjectMcpConfig(path);
				if (problem) log.warning(problem);
			}
		}
		rows.push({
			...row,
			agents: displayAgents(eligible),
			status: "installed",
		});
	}

	const npmClis: TemplateNpmCli[] = options.entries.flatMap((entry) =>
		entry.kind === "cli" && entry.item.kind === "npm" ? [entry.item] : [],
	);
	for (const cli of npmClis) {
		const row = { kind: "cli" as const, name: cli.name, agents: "" };
		const probe = ops.probe(cli.name, options.cwd);
		if (probe.found) {
			rows.push({
				...row,
				status: "found",
				...(probe.version ? { detail: probe.version } : {}),
			});
			continue;
		}
		const manual = `npm install -g ${shellQuote(cli.package)}`;
		if (!options.installGlobal) {
			rows.push({
				...row,
				status: "skipped",
				detail: "global install not confirmed",
			});
			next.push(manual);
			continue;
		}
		const install = ops.globalInstall(cli.package);
		if (install === undefined) {
			rows.push({
				...row,
				status: "skipped",
				detail: "npm, pnpm, or bun is needed for a global install",
			});
			next.push(manual);
			continue;
		}
		log.info(
			"Installing %s globally: %s %s",
			cli.package,
			install.command,
			install.args.join(" "),
		);
		const result = await ops.install(
			install.command,
			install.args,
			options.cwd,
		);
		rows.push(
			result.ok
				? { ...row, status: "installed", detail: cli.package }
				: { ...row, status: "failed", detail: result.detail },
		);
		if (!result.ok) {
			next.push(
				[install.command, ...install.args].map(shellQuote).join(" "),
			);
		}
	}

	for (const entry of options.entries) {
		if (entry.kind !== "cli" || entry.item.kind !== "system") continue;
		const cli = entry.item;
		const row = { kind: "cli" as const, name: cli.name, agents: "" };
		const probe = ops.probe(cli.name, options.cwd);
		if (!probe.found) {
			rows.push({ ...row, status: "skipped", detail: "not on PATH" });
			next.push(`Install ${cli.name}: ${systemCliHint(cli)}`);
			continue;
		}
		if (cli.minVersion !== undefined) {
			if (probe.version === undefined) {
				rows.push({
					...row,
					status: "skipped",
					detail: probe.detail ?? "version not recognized",
				});
				next.push(
					`Check ${cli.name} is ${cli.minVersion} or newer: ${systemCliHint(cli)}`,
				);
				continue;
			}
			if (!versionAtLeast(probe.version, cli.minVersion)) {
				rows.push({
					...row,
					status: "skipped",
					detail: `${probe.version} is older than ${cli.minVersion}`,
				});
				next.push(`Update ${cli.name}: ${systemCliHint(cli)}`);
				continue;
			}
		}
		rows.push({
			...row,
			status: "found",
			...(probe.version ? { detail: probe.version } : {}),
		});
	}

	return { rows, next };
};

/** The report as a table (skipped for JSON and YAML, whose callers carry it in their result), then each next step. */
export const reportTemplateTooling = (
	output: "table" | "json" | "yaml" | undefined,
	report: TemplateToolingReport,
): void => {
	if (report.rows.length === 0) return;
	if (output !== "json" && output !== "yaml") {
		const out = writer({ output: "table" });
		out.write(report.rows, {
			fields: ["kind", "name", "agents", "status", "detail"],
			title: "Template agent tooling",
		});
		out.end();
	}
	for (const command of report.next) {
		log.info("Run by hand: %s", command);
	}
};
