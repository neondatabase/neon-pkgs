import type yargs from "yargs";

import { readContextFile } from "../context.js";
import { log } from "../log.js";
import {
	existingNeonApiKey,
	installNeonMcpServer,
	NEON_MCP_CATEGORIES,
	NEON_MCP_URL,
	type NeonMcpAuth,
	type NeonMcpCategory,
	neonMcpUrl,
	parseMcpCategories,
	trackedProjectMcpConfig,
} from "../mcp/install.js";
import {
	mintedKeyRevokeCommand,
	mintMcpApiKey,
	withdrawMintedKey,
} from "../mcp/mint.js";
import { resolveMcpPlan } from "../mcp/plan.js";
import { mcpInstallableAgents, resolveInstallTargets } from "../mcp/targets.js";
import { confirmMcpInstall } from "../mcp/wizard.js";
import type { CommonProps } from "../types.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { getCliName } from "../utils/cli_name.js";
import { noPassthrough, single } from "../utils/flags.js";
import { helpCsv, helpEpilogue } from "../utils/help_text.js";
import { writer } from "../writer.js";

type McpProps = CommonProps & {
	oauth?: boolean;
	project?: boolean;
	yes?: boolean;
	readOnly?: boolean;
	projectId?: string;
	category?: NeonMcpCategory[];
};

type McpInstallRow = {
	agent: string;
	status: "installed" | "skipped" | "failed";
	error?: string;
};

export const command = "mcp";
export const describe = "Install the Neon MCP server into coding agents";

const mcpGlobalAgents = mcpInstallableAgents("global");
const mcpProjectAgents = mcpInstallableAgents("project");
const mcpProjectDroppedAgents = mcpGlobalAgents.filter(
	(id) => !mcpProjectAgents.includes(id),
);

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
					"Write project-level MCP config. Skips the config-location question. A linked project-folder install may still pin a project and scope a newly minted key",
			},
			yes: {
				alias: "y",
				type: "boolean",
				default: false,
				describe:
					"Skip prompts. Defaults listed below. --project, --oauth, --read-only, --project-id and --category still apply",
			},
			"read-only": {
				alias: "readonly",
				type: "boolean",
				default: false,
				describe:
					"Restrict MCP tools to read-only (?readonly=true). Not prompted. Does not change the minted key",
			},
			"project-id": {
				type: "string",
				describe:
					"Pin MCP tools to one Neon project (?projectId=). A newly minted API key is limited to that project. A linked project-folder install asks the same when you pick API-key auth",
				coerce: single("project-id"),
			},
			category: {
				type: "array",
				string: true,
				describe:
					"MCP tool category (repeatable or comma-separated). Default: all. Values listed below",
				coerce: (value: unknown): NeonMcpCategory[] => {
					if (value === undefined) return [];
					const list = Array.isArray(value) ? value : [value];
					if (list.length === 0) {
						throw new Error(
							"--category needs a value. Pass one, or omit the flag entirely.",
						);
					}
					const parts: string[] = [];
					for (const item of list) {
						if (typeof item !== "string" || item.trim() === "") {
							throw new Error(
								"--category needs a value. Pass one, or omit the flag entirely.",
							);
						}
						for (const part of item.split(",")) {
							const trimmed = part.trim();
							if (trimmed === "") {
								throw new Error(
									"--category needs a value. Pass one, or omit the flag entirely.",
								);
							}
							parts.push(trimmed);
						}
					}
					return parseMcpCategories(parts);
				},
			},
		})
		.example(
			"$0 mcp",
			"Interactive: config location, agents, auth, then confirm",
		)
		.example(
			"$0 mcp -y",
			"Global config, installed apps else the host CLI agent, reuse or mint an API key",
		)
		.example(
			"$0 mcp --oauth",
			"Install with OAuth; the agent signs in on first use",
		)
		.example("$0 mcp --project", "Write project-level config")
		.example("$0 mcp --read-only", "Hide write tools via ?readonly=true")
		.example(
			"$0 mcp --project-id <id>",
			"Pin tools to one project via ?projectId=",
		)
		.example(
			"$0 mcp --category querying --category schema",
			"Limit tools to those categories",
		)
		.epilogue(
			helpEpilogue(
				`Installs ${NEON_MCP_URL}`,
				helpCsv("Supported agents at global scope", mcpGlobalAgents),
				helpCsv("--project does not support", mcpProjectDroppedAgents),
				helpCsv("Supported categories", NEON_MCP_CATEGORIES),
				"neon mcp -y:",
				"  global config",
				"  globally installed apps, else the host CLI agent",
				"  reuse an existing Neon MCP API key, else mint an account-wide key",
				"  write tools on, all categories",
				"  no project pin (including from .neon)",
			),
		)
		.strict()
		.check(noPassthrough("mcp"));

export const handler = async (props: McpProps) => {
	const cwd = process.cwd();
	const interactive = canPickAgentsInteractively() && props.yes !== true;
	const linkedProjectId = readContextFile(props.contextFile).projectId;
	const plan = await resolveMcpPlan({
		project: props.project === true,
		oauth: props.oauth === true,
		agents: [],
		yes: props.yes === true,
		cwd,
		interactive,
		readOnly: props.readOnly === true,
		projectId: props.projectId,
		categories: props.category ?? [],
		linkedProjectId,
	});
	const { install, skipped } = resolveInstallTargets({
		agents: plan.agents,
		scope: plan.scope,
	});
	const url = neonMcpUrl({
		readOnly: plan.readOnly,
		projectId: plan.urlProjectId,
		categories: plan.categories,
	});

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
				`Authentication required. Run \`${getCliName()} auth\`, pass --api-key or use --oauth to install without a Neon credential.`,
			);
		}
		if (!canPickAgentsInteractively() && props.yes !== true) {
			throw new Error(
				"No interactive terminal. Pass -y to mint into every detected agent, or --oauth to install without minting.",
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
			url,
			mintProjectId: plan.urlProjectId,
		});
		if (!ok) {
			log.info("Aborted. Nothing was written.");
			return;
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
		if (plan.urlProjectId) {
			log.warning(
				"That key keeps its existing scope. Remove the Neon MCP entry to mint a project-scoped key, or pass --oauth to pin tools without a key.",
			);
		}
	} else {
		minted = await mintMcpApiKey({
			apiClient: props.apiClient,
			projectId: plan.urlProjectId,
		});
		auth = { kind: "api-key", apiKey: minted.key };
		if (minted.projectId) {
			log.info(
				"Limited to %s: it cannot create projects, mint API keys, or read any other project. It can still change and delete everything inside that project.",
				minted.projectId,
			);
		} else {
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
			url,
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
					: `Failed to write Neon MCP config to any agent. The minted API key could NOT be revoked. Remove it with \`${mintedKeyRevokeCommand(minted)}\`.`,
			);
		}
		throw new Error("Failed to write Neon MCP config to any agent.");
	}

	log.info("URL: %s", url);

	const out = writer(props);
	out.write(rows, {
		fields: ["agent", "status", "error"],
		title: "MCP",
	});
	out.end();

	if (minted) {
		log.info(
			"Minted API key %s (id %d, %s). Revoke with: %s",
			minted.name,
			minted.id,
			minted.projectId ? "project" : "account",
			mintedKeyRevokeCommand(minted),
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
