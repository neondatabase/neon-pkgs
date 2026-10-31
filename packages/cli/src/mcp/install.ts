import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { type AgentType, agents, upsertServer } from "add-mcp";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";

import { getCliName } from "../utils/cli_name.js";

export const NEON_MCP_URL = "https://mcp.neon.tech/mcp";
export const NEON_MCP_NAME = "Neon";

export const NEON_MCP_CATEGORIES = [
	"projects",
	"branches",
	"schema",
	"querying",
	"neon_auth",
	"data_api",
	"observability",
	"docs",
] as const;

export type NeonMcpCategory = (typeof NEON_MCP_CATEGORIES)[number];

export type McpInstallScope = "global" | "project";

export type NeonMcpUrlOptions = {
	readOnly?: boolean;
	projectId?: string;
	categories?: readonly string[];
};

export function isMcpCategory(value: string): value is NeonMcpCategory {
	for (const category of NEON_MCP_CATEGORIES) {
		if (category === value) {
			return true;
		}
	}
	return false;
}

export function parseMcpCategories(raw: readonly string[]): NeonMcpCategory[] {
	const out: NeonMcpCategory[] = [];
	for (const value of raw) {
		if (!isMcpCategory(value)) {
			throw new Error(
				`Unknown MCP category: "${value}". Supported categories: ${NEON_MCP_CATEGORIES.join(", ")}`,
			);
		}
		out.push(value);
	}
	return out;
}

export function isNeonMcpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname === "mcp.neon.tech" &&
			url.pathname === "/mcp"
		);
	} catch {
		return false;
	}
}

export function neonMcpUrl(options: NeonMcpUrlOptions = {}): string {
	const url = new URL(NEON_MCP_URL);
	if (options.readOnly === true) {
		url.searchParams.set("readonly", "true");
	}
	for (const category of options.categories ?? []) {
		url.searchParams.append("category", category);
	}
	const projectId = options.projectId?.trim();
	if (projectId) {
		url.searchParams.set("projectId", projectId);
	}
	return url.href;
}

export type NeonMcpAuth =
	| { kind: "oauth" }
	| { kind: "api-key"; apiKey: string };

export type NeonMcpInstallResult =
	| { ok: true; path: string }
	| { ok: false; unsupported: true; error: string }
	| { ok: false; unsupported: false; error: string };

const BEARER_RE = /Bearer\s+([^\s"]+)/i;

function nestedValue(root: unknown, key: string): unknown {
	if (key === "") {
		return root;
	}
	let current = root;
	for (const part of key.split(".")) {
		if (!current || typeof current !== "object" || Array.isArray(current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function bearerFromNeonMcpConfig(config: unknown): string | undefined {
	const record = recordOf(config);
	if (
		!record ||
		typeof record.url !== "string" ||
		!isNeonMcpUrl(record.url)
	) {
		return undefined;
	}
	const headers = record.headers ?? record.http_headers;
	const headerRecord = recordOf(headers);
	if (!headerRecord) {
		return undefined;
	}
	const authorization =
		headerRecord.Authorization ?? headerRecord.authorization;
	if (typeof authorization !== "string") {
		return undefined;
	}
	return BEARER_RE.exec(authorization.trim())?.[1];
}

function neonServers(value: unknown): unknown {
	const record = recordOf(value);
	if (!record) {
		return undefined;
	}
	return record[NEON_MCP_NAME] ?? record.neon;
}

function neonApiKeyFromFile(
	path: string,
	configKey: string,
): string | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const errors: ParseError[] = [];
	const parsed: unknown = parseJsonc(raw, errors, {
		allowTrailingComma: true,
	});
	if (errors.length === 0) {
		return bearerFromNeonMcpConfig(
			neonServers(nestedValue(parsed, configKey)),
		);
	}
	const neonBlock = raw.match(/\[mcp_servers\.Neon\][\s\S]*?(?=\n\[|$)/)?.[0];
	if (!neonBlock) {
		return undefined;
	}
	const url = neonBlock.match(/^url\s*=\s*"([^"]*)"/m)?.[1];
	if (!url || !isNeonMcpUrl(url)) {
		return undefined;
	}
	return BEARER_RE.exec(neonBlock)?.[1];
}

/**
 * Claude Code installs first so that a GitHub Copilot CLI install in the same run resolves to
 * the `.mcp.json` Claude Code creates, rather than to `.github/mcp.json`.
 */
export function mcpInstallOrder(selected: readonly AgentType[]): AgentType[] {
	return [
		...selected.filter((agent) => agent === "claude-code"),
		...selected.filter((agent) => agent !== "claude-code"),
	];
}

/** The file add-mcp's `upsertServer` writes for this agent when `selected` install in `mcpInstallOrder`. */
function configPathFor(
	agent: AgentType,
	scope: McpInstallScope,
	cwd: string,
	selected: readonly AgentType[],
): string | undefined {
	const spec = agents[agent];
	const local = scope === "project";
	if (local && !spec.localConfigPath) {
		return undefined;
	}
	if (
		local &&
		agent === "github-copilot-cli" &&
		selected.includes("claude-code")
	) {
		return join(cwd, ".mcp.json");
	}
	if (spec.resolveConfigPath) {
		return spec.resolveConfigPath(spec, { local, cwd });
	}
	return local && spec.localConfigPath
		? join(cwd, spec.localConfigPath)
		: spec.configPath;
}

/** Where an existing Neon entry can sit, depending on the file's current layout. */
function configKeysFor(agent: AgentType, scope: McpInstallScope): string[] {
	const spec = agents[agent];
	if (agent === "opencode") {
		return ["mcp.servers", "mcp"];
	}
	if (agent === "github-copilot-cli" && scope === "project") {
		return ["mcpServers", ""];
	}
	if (scope === "project" && spec.localConfigKey) {
		return [spec.localConfigKey];
	}
	return [spec.configKey];
}

export function existingNeonApiKey(options: {
	agents: AgentType[];
	scope: McpInstallScope;
	cwd: string;
}): string | undefined {
	for (const agent of options.agents) {
		const path = configPathFor(
			agent,
			options.scope,
			options.cwd,
			options.agents,
		);
		if (!path) {
			continue;
		}
		for (const configKey of configKeysFor(agent, options.scope)) {
			const key = neonApiKeyFromFile(path, configKey);
			if (key) {
				return key;
			}
		}
	}
	return undefined;
}

function isTrackedByGit(cwd: string, relativePath: string): boolean {
	try {
		execFileSync(
			"git",
			["-C", cwd, "ls-files", "--error-unmatch", "--", relativePath],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		return true;
	} catch {
		return false;
	}
}

export function trackedProjectMcpConfig(options: {
	agents: AgentType[];
	cwd: string;
}): string | undefined {
	for (const agent of options.agents) {
		const path = configPathFor(
			agent,
			"project",
			options.cwd,
			options.agents,
		);
		if (!path) {
			continue;
		}
		const relativePath = relative(options.cwd, path);
		if (isTrackedByGit(options.cwd, relativePath)) {
			return relativePath;
		}
	}
	return undefined;
}

export function mcpUnsupportedReason(
	agent: AgentType,
	scope: McpInstallScope,
	auth?: NeonMcpAuth["kind"],
): string | undefined {
	const spec = agents[agent];
	if (!spec.supportedTransports.includes("http")) {
		return (
			spec.unsupportedTransportMessage ??
			`${spec.displayName} does not support remote HTTP MCP servers.`
		);
	}
	if (scope === "project" && !spec.localConfigPath) {
		return `${spec.displayName} does not support project-level MCP config.`;
	}
	if (agent === "fx" && auth === "api-key") {
		return `fx does not accept an API key in its MCP config. Run \`${getCliName()} mcp --oauth --agent fx\`.`;
	}
	return undefined;
}

/**
 * add-mcp refuses a project-level Claude Code install while `.github/mcp.json` exists without
 * `.mcp.json`, because GitHub Copilot CLI reads `.mcp.json` first once it exists. Neon writes
 * Claude Code's file anyway, so it creates `.mcp.json` before calling add-mcp.
 */
function createClaudeProjectConfig(cwd: string): string | undefined {
	const path = join(cwd, ".mcp.json");
	if (existsSync(path) || !existsSync(join(cwd, ".github", "mcp.json"))) {
		return undefined;
	}
	writeFileSync(path, '{\n  "mcpServers": {}\n}\n');
	return path;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function gitignoreProjectConfig(path: string): string | undefined {
	const dir = dirname(path);
	const entry = basename(path);
	const gitignorePath = join(dir, ".gitignore");
	try {
		if (!existsSync(gitignorePath)) {
			writeFileSync(gitignorePath, `${entry}\n`);
			return undefined;
		}
		const current = readFileSync(gitignorePath, "utf8");
		if (current.split(/\r?\n/).some((line) => line.trim() === entry)) {
			return undefined;
		}
		const needsLeadingNewline =
			current.length > 0 && !current.endsWith("\n");
		writeFileSync(
			gitignorePath,
			`${current}${needsLeadingNewline ? "\n" : ""}${entry}\n`,
		);
		return undefined;
	} catch (err) {
		return `Could not gitignore ${path}: ${
			err instanceof Error ? err.message : String(err)
		}`;
	}
}

function protectWrittenConfig(
	path: string,
	scope: McpInstallScope,
): string | undefined {
	try {
		chmodSync(path, 0o600);
	} catch (err) {
		return `Could not restrict permissions on ${path}: ${
			err instanceof Error ? err.message : String(err)
		}`;
	}
	if (scope === "project") {
		return gitignoreProjectConfig(path);
	}
	return undefined;
}

function redactSecrets(text: string): string {
	return text
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/napi_[A-Za-z0-9_]+/gi, "napi_[redacted]");
}

export function installNeonMcpServer(options: {
	agent: AgentType;
	scope: McpInstallScope;
	cwd?: string;
	auth?: NeonMcpAuth;
	url?: string;
}): NeonMcpInstallResult {
	const auth = options.auth ?? { kind: "oauth" };
	const url = options.url ?? NEON_MCP_URL;

	// add-mcp can write unusable HTTP entries; project installs cannot fall back to global config.
	const unsupported = mcpUnsupportedReason(
		options.agent,
		options.scope,
		auth.kind,
	);
	if (unsupported) {
		return { ok: false, unsupported: true, error: unsupported };
	}

	const server =
		auth.kind === "api-key"
			? {
					type: "http" as const,
					url,
					headers: {
						Authorization: `Bearer ${auth.apiKey}`,
					},
				}
			: { type: "http" as const, url };

	const cwd = options.cwd ?? process.cwd();
	let created: string | undefined;
	if (options.agent === "claude-code" && options.scope === "project") {
		try {
			created = createClaudeProjectConfig(cwd);
		} catch (err) {
			return {
				ok: false,
				unsupported: false,
				error: `Could not create ${join(cwd, ".mcp.json")}: ${errorMessage(err)}`,
			};
		}
	}
	const result = upsertServer(options.agent, NEON_MCP_NAME, server, {
		local: options.scope === "project",
		cwd,
	});
	if (!result.success && created) {
		try {
			rmSync(created, { force: true });
		} catch (err) {
			return {
				ok: false,
				unsupported: false,
				error: `${redactSecrets(result.error ?? "Failed to write Neon MCP server config")} Could not remove ${created}: ${errorMessage(err)}`,
			};
		}
	}

	if (result.success) {
		if (auth.kind === "api-key") {
			const paths = [result.path, ...(result.extraPaths ?? [])];
			for (const path of paths) {
				const error = protectWrittenConfig(path, options.scope);
				if (error) {
					return { ok: false, unsupported: false, error };
				}
			}
		}
		return { ok: true, path: result.path };
	}

	return {
		ok: false,
		unsupported: false,
		error: redactSecrets(
			result.error ?? "Failed to write Neon MCP server config",
		),
	};
}
