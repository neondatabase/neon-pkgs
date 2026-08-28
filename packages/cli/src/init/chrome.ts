import chalk from "chalk";

import { isCi } from "../env.js";
import type { InitAgentSetup } from "./plan.js";

export const NEON_GREEN = "#4BB578";

export const INIT_BANNER_LINES = [
	" ██╗  ██╗██████╗  ██████╗ ██╗  ██╗",
	" ███╗ ██║██╔═══╝ ██╔═══██╗███╗ ██║",
	" ████╗██║██████╗ ██║   ██║████╗██║",
	" ██╔████║██╔═══╝ ██║   ██║██╔████║",
	" ██║╚███║██████╗ ╚██████╔╝██║╚███║",
	" ╚═╝ ╚══╝╚═════╝  ╚═════╝ ╚═╝ ╚══╝",
] as const;

export const formatInitBanner = (): string => INIT_BANNER_LINES.join("\n");

export const shouldPrintInitBanner = (yes: boolean): boolean =>
	!yes && !isCi() && Boolean(process.stdout.isTTY);

export const printInitBanner = (): void => {
	process.stdout.write(
		`\n${chalk.hex(NEON_GREEN)(formatInitBanner())}\n\n${chalk.dim("Let's get this directory set up with Neon.")}\n\n`,
	);
};

export type InitDoneRow = {
	label: string;
	value: string;
};

export const formatInitDone = (input: {
	heading: string;
	rows: readonly InitDoneRow[];
	next: readonly string[];
}): string => {
	const labelWidth = Math.max(
		0,
		...input.rows.map((row) => row.label.length),
	);
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
	return `${input.heading}\n${rule}${body}${next}\n`;
};

export const printInitDone = (text: string): void => {
	const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
	const lines = trimmed.split("\n");
	const painted = lines.map((line, index) => {
		if (index === 0) {
			return chalk.hex(NEON_GREEN).bold(line);
		}
		if (/^-{3,}$/.test(line)) {
			return chalk.hex(NEON_GREEN)(line);
		}
		if (line === "Next:") {
			return chalk.bold(line);
		}
		return line;
	});
	process.stdout.write(`\n${painted.join("\n")}\n\n`);
};

export const agentSetupLabel = (setup: InitAgentSetup): string => {
	if (setup === "plugin") {
		return "plugin";
	}
	if (setup === "skills-mcp") {
		return "skills and MCP";
	}
	return "skipped";
};

export const agentSetupDoneLabel = (input: {
	setup: InitAgentSetup;
	ran: boolean;
}): string => {
	if (!input.ran && input.setup !== "skip") {
		return "not run";
	}
	return agentSetupLabel(input.setup);
};
