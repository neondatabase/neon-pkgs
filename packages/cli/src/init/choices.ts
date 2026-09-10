import { getCliName } from "../utils/cli_name.js";

export type InitConfigPlan =
	| { kind: "skip" }
	| { kind: "write"; services?: readonly string[] };

export type InitConfigResolution =
	| { kind: "skip" }
	| { kind: "ask" }
	| { kind: "write"; services?: readonly string[] };

export type InitTemplateResolution =
	| { kind: "existing" }
	| { kind: "ask" }
	| { kind: "skip" }
	| { kind: "default" }
	| { kind: "template"; id: string };

export const INIT_TEMPLATE_CONFLICT =
	"--skip-template cannot be combined with --template.";

export const INIT_CONFIG_SERVICES_CONFLICT =
	"--no-config cannot be combined with --services.";

export const initTemplateInNonEmptyMessage = (): string =>
	`--template is only for an empty directory. This directory already has files, so there is nothing to scaffold. Omit --template, or run \`${getCliName()} bootstrap\` in an empty folder.`;

export const resolveInitTemplateChoice = (input: {
	empty: boolean;
	yes: boolean;
	skipTemplate: boolean;
	template?: string;
}): InitTemplateResolution => {
	const id = input.template?.trim();
	const hasTemplate = id !== undefined && id.length > 0;
	if (input.skipTemplate && hasTemplate) {
		throw new Error(INIT_TEMPLATE_CONFLICT);
	}
	if (!input.empty) {
		if (hasTemplate) {
			throw new Error(initTemplateInNonEmptyMessage());
		}
		return { kind: "existing" };
	}
	if (input.skipTemplate) {
		return { kind: "skip" };
	}
	if (hasTemplate) {
		return { kind: "template", id };
	}
	if (input.yes) {
		return { kind: "default" };
	}
	return { kind: "ask" };
};

export const resolveInitConfigChoice = (input: {
	flag: boolean | undefined;
	yes: boolean;
	canAsk: boolean;
	existingConfig: boolean;
	services?: readonly string[];
}): InitConfigResolution => {
	if (input.flag === false && input.services !== undefined) {
		throw new Error(INIT_CONFIG_SERVICES_CONFLICT);
	}
	if (input.flag === false) {
		return { kind: "skip" };
	}
	if (input.existingConfig) {
		return { kind: "write" };
	}
	if (input.services !== undefined) {
		return { kind: "write", services: input.services };
	}
	if (input.yes) {
		return { kind: "write", services: ["none"] };
	}
	if (input.flag === true) {
		return { kind: "write" };
	}
	if (input.canAsk) {
		return { kind: "ask" };
	}
	return { kind: "write" };
};

export const configPlanFromResolution = (
	resolution: InitConfigResolution,
	accepted: boolean | undefined,
): InitConfigPlan => {
	if (resolution.kind === "ask") {
		return accepted === true ? { kind: "write" } : { kind: "skip" };
	}
	if (resolution.kind === "skip") {
		return { kind: "skip" };
	}
	return resolution;
};

export const shouldRefreshEnvAfterNewConfig = (input: {
	wroteNewFile: boolean;
	projectId?: string;
	branch?: string;
}): boolean =>
	input.wroteNewFile &&
	typeof input.projectId === "string" &&
	input.projectId.length > 0 &&
	typeof input.branch === "string" &&
	input.branch.length > 0;
