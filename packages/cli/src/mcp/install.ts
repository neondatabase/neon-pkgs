import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type AgentType, agents, upsertServer } from "add-mcp";

export const NEON_MCP_URL = "https://mcp.neon.tech/mcp";
export const NEON_MCP_NAME = "Neon";

export type McpInstallScope = "global" | "project";

export type NeonMcpAuth =
	| { kind: "oauth" }
	| { kind: "api-key"; apiKey: string };

export type NeonMcpInstallResult =
	| { ok: true; path: string }
	| { ok: false; unsupported: true; error: string }
	| { ok: false; unsupported: false; error: string };

const BEARER_RE = /Bearer\s+([^\s"]+)/i;

function nestedValue(root: unknown, key: string): unknown {
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
	if (!record || record.url !== NEON_MCP_URL) {
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
	try {
		const parsed: unknown = JSON.parse(raw);
		return bearerFromNeonMcpConfig(
			neonServers(nestedValue(parsed, configKey)),
		);
	} catch {
		const neonBlock = raw.match(
			/\[mcp_servers\.Neon\][\s\S]*?(?=\n\[|$)/,
		)?.[0];
		if (!neonBlock) {
			return undefined;
		}
		const url = neonBlock.match(/^url\s*=\s*"([^"]*)"/m)?.[1];
		if (url !== NEON_MCP_URL) {
			return undefined;
		}
		return BEARER_RE.exec(neonBlock)?.[1];
	}
}

function configPathFor(
	agent: AgentType,
	scope: McpInstallScope,
	cwd: string,
): string | undefined {
	const spec = agents[agent];
	if (scope === "project") {
		if (!spec.localConfigPath) {
			return undefined;
		}
		return join(cwd, spec.localConfigPath);
	}
	return spec.configPath;
}

export function existingNeonApiKey(options: {
	agents: AgentType[];
	scope: McpInstallScope;
	cwd: string;
}): string | undefined {
	for (const agent of options.agents) {
		const path = configPathFor(agent, options.scope, options.cwd);
		if (!path) {
			continue;
		}
		const key = neonApiKeyFromFile(path, agents[agent].configKey);
		if (key) {
			return key;
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
		const relativePath = agents[agent].localConfigPath;
		if (!relativePath) {
			continue;
		}
		if (isTrackedByGit(options.cwd, relativePath)) {
			return relativePath;
		}
	}
	return undefined;
}

export function mcpUnsupportedReason(
	agent: AgentType,
	scope: McpInstallScope,
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
	return undefined;
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

export function installNeonMcpServer(options: {
	agent: AgentType;
	scope: McpInstallScope;
	cwd?: string;
	auth?: NeonMcpAuth;
}): NeonMcpInstallResult {
	const auth = options.auth ?? { kind: "oauth" };

	// Guard first because add-mcp can write unusable HTTP entries, and project installs must not change scope.
	const unsupported = mcpUnsupportedReason(options.agent, options.scope);
	if (unsupported) {
		return { ok: false, unsupported: true, error: unsupported };
	}

	const server =
		auth.kind === "api-key"
			? {
					type: "http" as const,
					url: NEON_MCP_URL,
					headers: {
						Authorization: `Bearer ${auth.apiKey}`,
					},
				}
			: { type: "http" as const, url: NEON_MCP_URL };

	const result = upsertServer(options.agent, NEON_MCP_NAME, server, {
		local: options.scope === "project",
		cwd: options.cwd,
	});

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
		error: result.error ?? "Failed to write Neon MCP server config",
	};
}
