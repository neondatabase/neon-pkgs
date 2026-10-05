import { displayPath, row } from "./env_output.js";

export type LinkSummaryView = {
	contextFile: string;
	orgId?: string;
	projectId: string;
	projectName?: string;
	branch: string;
	created: boolean;
	regionId?: string;
	noChecks?: boolean;
};

export const formatLinkSummary = (
	summary: LinkSummaryView,
	cwd: string,
): string => {
	const lines: string[] = [];
	if (summary.created) {
		lines.push(
			`Created project ${summary.projectName ?? summary.projectId}${summary.regionId ? ` in ${summary.regionId}` : ""}`,
		);
	}
	lines.push(`Linked ${displayPath(summary.contextFile, cwd)}`);
	lines.push(
		row(
			"Project",
			summary.projectName
				? `${summary.projectName} (${summary.projectId})`
				: summary.projectId,
		),
	);
	lines.push(row("Branch", summary.branch));
	if (summary.orgId) lines.push(row("Org", summary.orgId));
	if (summary.noChecks) {
		lines.push("");
		lines.push("Written offline (--no-checks): nothing was verified.");
	}
	return `${lines.join("\n")}\n`;
};
