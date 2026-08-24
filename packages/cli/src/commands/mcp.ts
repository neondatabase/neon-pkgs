import type yargs from "yargs";

import { readContextFile } from "../context.js";
import { log } from "../log.js";
import { listMcpAgentIds } from "../mcp/agents.js";
import {
	existingNeonApiKey,
	installNeonMcpServer,
	type McpInstallScope,
	type NeonMcpAuth,
} from "../mcp/install.js";
import { mintMcpApiKey, withdrawMintedKey } from "../mcp/mint.js";
import {
	detectMcpAgents,
	mcpInstallableAgents,
	resolveInstallTargets,
} from "../mcp/targets.js";
import type { CommonProps } from "../types.js";
import {
	agentChoicesFrom,
	resolveAgentSelection,
} from "../utils/agent_picker.js";
import { getCliName } from "../utils/cli_name.js";
import { noPassthrough } from "../utils/flags.js";
import { writer } from "../writer.js";

type McpProps = CommonProps & {
	oauth?: boolean;
	project?: boolean;
	agent?: string[];
};

type McpInstallRow = {
	agent: string;
	status: "installed" | "skipped" | "failed";
	error?: string;
};

export const command = "mcp";
export const describe = "Install the Neon MCP server into coding agents";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 mcp [options]")
		.options({
			oauth: {
				type: "boolean",
				default: false,
				describe:
					"Install with OAuth instead of minting an API key (no Neon login)",
			},
			project: {
				type: "boolean",
				default: false,
				describe:
					"Write project-level MCP config and mint a project-scoped API key from the linked .neon project",
			},
			agent: {
				alias: "a",
				type: "array",
				string: true,
				describe:
					"Coding agent to install into (repeatable). Interactive picker when omitted; detected agents in CI",
				coerce: (value: unknown): string[] => {
					if (value === undefined) return [];
					const list = Array.isArray(value) ? value : [value];
					return list.map((item) => {
						if (typeof item !== "string" || item.trim() === "") {
							throw new Error(
								"--agent needs a value. Pass one, or omit the flag entirely.",
							);
						}
						return item;
					});
				},
			},
		})
		.example(
			"$0 mcp",
			"Pick agents (or detected agents in CI), minting an API key",
		)
		.example("$0 mcp --oauth", "Install with OAuth, without minting a key")
		.example(
			"$0 mcp --project",
			"Write project config and mint a project-scoped key",
		)
		.example(
			"$0 mcp --agent cursor --agent claude-code",
			"Install into specific agents",
		)
		.strict()
		.check(noPassthrough("mcp"));

export const handler = async (props: McpProps) => {
	const scope: McpInstallScope = props.project ? "project" : "global";
	const cwd = process.cwd();
	const available = mcpInstallableAgents(scope);
	const detected = await detectMcpAgents({ scope, cwd });
	const selected = await resolveAgentSelection({
		specified: props.agent ?? [],
		choices: agentChoicesFrom(available, detected),
		detected,
		message:
			"Which coding agents should get the Neon MCP server? (space to toggle, enter to confirm)",
		nonInteractiveMessage: `No coding agents detected. Pass --agent <name>. Supported agents: ${listMcpAgentIds().join(", ")}`,
	});
	const { install, skipped } = resolveInstallTargets({
		agents: selected,
		scope,
	});

	const oauth = props.oauth === true;
	const projectId =
		props.project && !oauth
			? readContextFile(props.contextFile).projectId
			: undefined;
	if (props.project && !oauth && !projectId) {
		throw new Error(
			`No Neon project linked. Run \`${getCliName()} link\` to link this directory to a project.`,
		);
	}

	let auth: NeonMcpAuth;
	let minted: Awaited<ReturnType<typeof mintMcpApiKey>> | undefined;
	if (oauth) {
		auth = { kind: "oauth" };
	} else {
		const existing = existingNeonApiKey({
			agents: install,
			scope,
			cwd,
		});
		if (existing) {
			auth = { kind: "api-key", apiKey: existing };
			log.info(
				"Reusing the API key already configured for the Neon MCP server.",
			);
		} else {
			if (!props.apiClient || !props.apiKey) {
				throw new Error(
					`Authentication required. Run \`${getCliName()} auth\` or pass --api-key.`,
				);
			}
			minted = await mintMcpApiKey({
				apiClient: props.apiClient,
				projectId,
			});
			auth = { kind: "api-key", apiKey: minted.key };
		}
	}

	const rows: McpInstallRow[] = [];
	let successes = 0;
	for (const agent of install) {
		const result = installNeonMcpServer({
			agent,
			scope,
			cwd,
			auth,
		});
		if (result.ok) {
			successes += 1;
			rows.push({ agent, status: "installed" });
			log.info("Wrote %s", result.path);
		} else {
			rows.push({
				agent,
				status: result.unsupported ? "skipped" : "failed",
				error: result.error,
			});
			log.error("%s: %s", agent, result.error);
		}
	}
	for (const row of skipped) {
		rows.push({
			agent: row.agent,
			status: "skipped",
			error: row.error,
		});
		log.info("%s: %s", row.agent, row.error);
	}

	if (successes === 0) {
		if (minted && props.apiClient) {
			const withdrawn = await withdrawMintedKey(props.apiClient, minted);
			throw new Error(
				withdrawn
					? "Failed to write Neon MCP config to any agent. The minted API key has been revoked."
					: `Failed to write Neon MCP config to any agent. The minted API key could NOT be revoked. Remove it with \`${getCliName()} api-keys revoke ${minted.id}${minted.orgId ? ` --org-id ${minted.orgId}` : ""}\`.`,
			);
		}
		throw new Error("Failed to write Neon MCP config to any agent.");
	}

	const out = writer(props);
	out.write(rows, {
		fields: ["agent", "status", "error"],
		title: "MCP",
	});
	out.end();

	if (minted) {
		const revoke = minted.orgId
			? `${getCliName()} api-keys revoke ${minted.id} --org-id ${minted.orgId}`
			: `${getCliName()} api-keys revoke ${minted.id}`;
		log.info(
			"Minted API key %s (id %d%s). Revoke with: %s",
			minted.name,
			minted.id,
			minted.projectId ? `, project ${minted.projectId}` : ", account",
			revoke,
		);
		if (!minted.projectId) {
			log.warning(
				"This key reaches everything your account can, in every organization.",
			);
		}
	}
};
