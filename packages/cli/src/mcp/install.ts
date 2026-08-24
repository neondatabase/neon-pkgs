import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentType, agents, upsertServer } from "add-mcp";

import { ensureGitignored } from "../context.js";
import { log } from "../log.js";

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

const BEARER_RE = /Bearer\s+(\S+)/i;

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

function bearerFromServerConfig(config: unknown): string | undefined {
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		return undefined;
	}
	const record = config as Record<string, unknown>;
	const headers = record.headers ?? record.http_headers;
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
		return undefined;
	}
	const authorization =
		(headers as Record<string, unknown>).Authorization ??
		(headers as Record<string, unknown>).authorization;
	if (typeof authorization !== "string") {
		return undefined;
	}
	return BEARER_RE.exec(authorization.trim())?.[1];
}

function neonServers(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
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
		return bearerFromServerConfig(
			neonServers(nestedValue(parsed, configKey)),
		);
	} catch {
		const neonBlock = raw.match(
			/\[mcp_servers\.Neon\][\s\S]*?(?=\n\[|$)/,
		)?.[0];
		const source = neonBlock ?? raw;
		return BEARER_RE.exec(source)?.[1];
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

function protectWrittenConfig(path: string, scope: McpInstallScope): void {
	try {
		chmodSync(path, 0o600);
	} catch (err) {
		log.debug(
			"Could not restrict permissions on %s: %s",
			path,
			err instanceof Error ? err.message : String(err),
		);
	}
	if (scope === "project") {
		ensureGitignored(path);
	}
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
			protectWrittenConfig(result.path, options.scope);
			for (const extra of result.extraPaths ?? []) {
				protectWrittenConfig(extra, options.scope);
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
