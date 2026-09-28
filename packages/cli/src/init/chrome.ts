import chalk from "chalk";

import { isCi } from "../env.js";
import type { AgentType } from "../mcp/agents.js";
import {
	HEADING_CANCELLED,
	HEADING_COMPLETE,
	HEADING_FAILED,
	HEADING_PENDING,
	INIT_SUBTITLE,
	type InitOutcomeKind,
} from "./copy.js";
import type { InitFunnelConfig, InitFunnelLink } from "./funnel.js";
import type { InitAgentSetupResult, InitToolingPlan } from "./plan.js";

export const NEON_GREEN = "#4BB578";

export const INIT_BANNER_LINES = [
	" ██╗  ██╗██████╗ ██████╗ ██╗  ██╗",
	" ███╗ ██║██╔═══╝██╔═══██╗███╗ ██║",
	" ████╗██║██████╗██║   ██║████╗██║",
	" ██╔████║██╔═══╝██║   ██║██╔████║",
	" ██║╚███║██████╗╚██████╔╝██║╚███║",
	" ╚═╝ ╚══╝╚═════╝ ╚═════╝ ╚═╝ ╚══╝",
] as const;

export const formatInitBanner = (): string => INIT_BANNER_LINES.join("\n");

export const shouldPrintInitBanner = (yes: boolean): boolean =>
	!yes && !isCi() && Boolean(process.stdout.isTTY);

export const printInitBanner = (): void => {
	process.stdout.write(
		`\n${chalk.hex(NEON_GREEN)(formatInitBanner())}\n\n${chalk.dim(INIT_SUBTITLE)}\n\n`,
	);
};

export const printInitProgress = (message: string): void => {
	process.stdout.write(`${message}\n`);
};

export type InitDoneRow = {
	label: string;
	value: string;
};

export const formatInitDone = (input: {
	heading: string;
	body?: string;
	rows: readonly InitDoneRow[];
	next: readonly string[];
}): string => {
	const labelWidth = Math.max(
		0,
		...input.rows.map((row) => row.label.length),
	);
	const intro =
		input.body !== undefined && input.body.length > 0
			? `\n\n${input.body}`
			: "";
	const body =
		input.rows.length === 0
			? ""
			: `\n\n${input.rows
					.map(
						(row) =>
							`  ${row.label.padEnd(labelWidth)}  ${row.value}`,
					)
					.join("\n")}`;
	const next =
		input.next.length === 0
			? ""
			: `\n\nNext:\n${input.next.map((line) => `  ${line}`).join("\n")}`;
	const rule = "-".repeat(input.heading.length);
	return `${input.heading}\n${rule}${intro}${body}${next}\n`;
};

const headingColor = (heading: string): ((text: string) => string) => {
	if (heading === HEADING_COMPLETE) {
		return chalk.hex(NEON_GREEN).bold;
	}
	if (heading === HEADING_PENDING) {
		return chalk.yellow.bold;
	}
	if (heading === HEADING_FAILED) {
		return chalk.red.bold;
	}
	if (heading === HEADING_CANCELLED) {
		return chalk.dim;
	}
	return chalk.hex(NEON_GREEN).bold;
};

export const printInitDone = (text: string): void => {
	const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
	const lines = trimmed.split("\n");
	const heading = lines[0] ?? "";
	const paintHeading = headingColor(heading);
	const painted = lines.map((line, index) => {
		if (index === 0) {
			return paintHeading(line);
		}
		if (/^-{3,}$/.test(line)) {
			return heading === HEADING_FAILED
				? chalk.red(line)
				: heading === HEADING_PENDING
					? chalk.yellow(line)
					: heading === HEADING_CANCELLED
						? chalk.dim(line)
						: chalk.hex(NEON_GREEN)(line);
		}
		if (line === "Next:") {
			return chalk.bold(line);
		}
		return line;
	});
	process.stdout.write(`\n${painted.join("\n")}\n\n`);
};

export const agentSetupLabel = (setup: InitAgentSetupResult): string => {
	if (setup === "plugin") {
		return "plugin";
	}
	if (setup === "skills-mcp") {
		return "skills and MCP";
	}
	if (setup === "skills") {
		return "skills";
	}
	if (setup === "mcp") {
		return "MCP";
	}
	return "skipped";
};

export const agentSetupDoneLabel = (input: {
	setup: InitAgentSetupResult;
	ran: boolean;
}): string => {
	if (!input.ran && input.setup !== "skip") {
		return "not run";
	}
	return agentSetupLabel(input.setup);
};

const formatAgentIds = (agents: readonly AgentType[]): string =>
	agents.join(", ");

const SETUP_LABELS: { [K in InitToolingPlan["setup"]]: string } = {
	skip: "skipped",
	plugin: "Neon plugin",
	skills: "skills",
	"skills-mcp": "skills and MCP",
	mixed: "plugin and skills/MCP",
};

/** Names the agents behind each mechanism, since init picks skills and MCP agents separately. */
export const agentsRowValue = (input: {
	tooling: InitToolingPlan;
	installed: readonly AgentType[];
}): string => {
	const { tooling } = input;
	const parts: string[] = [];
	const add = (label: string, ids: readonly AgentType[]): void => {
		const ran = ids.filter((id) => input.installed.includes(id));
		if (ran.length > 0) {
			parts.push(`${label}: ${formatAgentIds(ran)}`);
		}
	};
	if (tooling.setup === "plugin" || tooling.setup === "skills") {
		add(SETUP_LABELS[tooling.setup], tooling.agents);
	} else if (tooling.setup === "skills-mcp" || tooling.setup === "mixed") {
		if (tooling.setup === "mixed") {
			add("Neon plugin", tooling.pluginAgents);
		}
		const sameAgents =
			tooling.skillsAgents.length === tooling.mcpAgents.length &&
			tooling.skillsAgents.every((id) => tooling.mcpAgents.includes(id));
		if (sameAgents) {
			add("skills and MCP", tooling.skillsAgents);
		} else {
			add("skills", tooling.skillsAgents);
			add("MCP", tooling.mcpAgents);
		}
	}
	return parts.length > 0 ? parts.join("; ") : SETUP_LABELS[tooling.setup];
};

export const projectRowValue = (link: InitFunnelLink | null): string => {
	switch (link) {
		case "already_linked":
			return "already linked";
		case "linked":
			return "linked";
		case "claimable":
			return "claimable";
		case "skipped":
			return "skipped";
		case null:
			return "not linked";
		default: {
			const _exhaustive: never = link;
			return _exhaustive;
		}
	}
};

export type InitConfigSummary = "created" | "skipped" | "existing" | "template";

export const configSummaryLabel = (summary: InitConfigSummary): string => {
	switch (summary) {
		case "created":
			return "neon.ts created";
		case "skipped":
			return "skipped";
		case "existing":
			return "existing Neon config";
		case "template":
			return "provided by template";
		default: {
			const _exhaustive: never = summary;
			return _exhaustive;
		}
	}
};

export const configRowValue = (
	config: InitFunnelConfig | null,
	filename?: string,
): string => {
	if (config === "created") {
		return "neon.ts created";
	}
	if (config === "existing") {
		return `existing ${filename ?? "Neon config"} preserved`;
	}
	if (config === "skipped" || config === null) {
		return "skipped";
	}
	const _exhaustive: never = config;
	return _exhaustive;
};

export const headingForKind = (kind: InitOutcomeKind): string => {
	switch (kind) {
		case "success":
			return HEADING_COMPLETE;
		case "pending":
			return HEADING_PENDING;
		case "error":
			return HEADING_FAILED;
		case "aborted":
			return HEADING_CANCELLED;
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
};
