import type yargs from "yargs";

import { readContextFile } from "../context.js";
import { log } from "../log.js";
import {
	existingNeonApiKey,
	installNeonMcpServer,
	type NeonMcpAuth,
	trackedProjectMcpConfig,
} from "../mcp/install.js";
import { mintMcpApiKey, withdrawMintedKey } from "../mcp/mint.js";
import { resolveMcpPlan } from "../mcp/plan.js";
import { resolveInstallTargets } from "../mcp/targets.js";
import { confirmMcpInstall } from "../mcp/wizard.js";
import type { CommonProps } from "../types.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { getCliName } from "../utils/cli_name.js";
import { noPassthrough } from "../utils/flags.js";
import { writer } from "../writer.js";

type McpProps = CommonProps & {
	oauth?: boolean;
	project?: boolean;
	yes?: boolean;
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
					"Write the server URL only. The agent prompts for Neon sign-in on first use. No CLI login, no API key minted. Skips the auth question",
			},
			project: {
				type: "boolean",
				default: false,
				describe:
					"Write project-level MCP config. Skips the scope question. A minted key is limited to the linked .neon project",
			},
			yes: {
				alias: "y",
				type: "boolean",
				default: false,
				describe:
					"Skip prompts. Defaults to global config, every detected agent, and a minted API key. --project, --oauth, and --agent still apply",
			},
			agent: {
				alias: "a",
				type: "array",
				string: true,
				describe:
					"Coding agent to install into (repeatable). Skips the agent picker",
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
		.example("$0 mcp", "Interactive: scope, agents, auth, then confirm")
		.example("$0 mcp -y", "Global config, detected agents, minted API key")
		.example(
			"$0 mcp --oauth",
			"Install with OAuth; the agent signs in on first use",
		)
		.example("$0 mcp --project", "Write project-level config")
		.example(
			"$0 mcp --agent cursor --agent claude-code",
			"Install into specific agents",
		)
		.strict()
		.check(noPassthrough("mcp"));

export const handler = async (props: McpProps) => {
	const cwd = process.cwd();
	const interactive = canPickAgentsInteractively() && props.yes !== true;
	const plan = await resolveMcpPlan({
		project: props.project === true,
		oauth: props.oauth === true,
		agents: props.agent ?? [],
		yes: props.yes === true,
		cwd,
		interactive,
	});
	const { install, skipped } = resolveInstallTargets({
		agents: plan.agents,
		scope: plan.scope,
	});

	const projectId =
		plan.scope === "project" && plan.auth === "api-key"
			? readContextFile(props.contextFile).projectId
			: undefined;
	if (plan.scope === "project" && plan.auth === "api-key" && !projectId) {
		throw new Error(
			`No Neon project linked. Run \`${getCliName()} link\` to link this directory to a project.`,
		);
	}
	if (plan.scope === "project" && plan.auth === "api-key") {
		const tracked = trackedProjectMcpConfig({ agents: install, cwd });
		if (tracked) {
			throw new Error(
				`${tracked} is tracked by git. Untrack it before writing an API key, or pass --oauth.`,
			);
		}
	}

	const existing =
		plan.auth === "api-key"
			? existingNeonApiKey({
					agents: install,
					scope: plan.scope,
					cwd,
				})
			: undefined;
	if (plan.auth === "api-key" && !existing) {
		if (!props.apiClient || !props.apiKey) {
			throw new Error(
				`Authentication required. Run \`${getCliName()} auth\`, pass --api-key, or use --oauth to install without a Neon credential.`,
			);
		}
	}

	if (interactive) {
		const ok = await confirmMcpInstall({
			scope: plan.scope,
			install,
			skipped,
			auth: plan.auth,
			reuse: existing !== undefined,
		});
		if (!ok) {
			throw new Error("Aborted. Nothing was written.");
		}
	}

	let auth: NeonMcpAuth;
	let minted: Awaited<ReturnType<typeof mintMcpApiKey>> | undefined;
	if (plan.auth === "oauth") {
		auth = { kind: "oauth" };
	} else if (existing) {
		auth = { kind: "api-key", apiKey: existing };
		log.info(
			"Reusing the API key already configured for the Neon MCP server.",
		);
	} else {
		minted = await mintMcpApiKey({
			apiClient: props.apiClient,
			projectId,
		});
		auth = { kind: "api-key", apiKey: minted.key };
		if (!minted.projectId) {
			log.warning(
				"This key reaches everything your account can, in every organization.",
			);
		}
	}

	const rows: McpInstallRow[] = [];
	let successes = 0;
	const failedAgents: string[] = [];
	for (const agent of install) {
		const result = installNeonMcpServer({
			agent,
			scope: plan.scope,
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
			if (!result.unsupported) {
				failedAgents.push(agent);
			}
		}
	}
	for (const row of skipped) {
		rows.push({
			agent: row.agent,
			status: "skipped",
			error: row.error,
		});
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
	}

	if (plan.auth === "oauth") {
		log.info("The agent will prompt for Neon sign-in on first use.");
	}

	if (failedAgents.length > 0) {
		throw new Error(
			`Failed to write Neon MCP config for: ${failedAgents.join(", ")}.`,
		);
	}
};
