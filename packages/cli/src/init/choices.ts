export type InitConfigPlan =
	| { kind: "skip" }
	| { kind: "write"; services?: readonly string[] };

export type InitConfigResolution =
	| { kind: "skip" }
	| { kind: "ask" }
	| { kind: "write"; services?: readonly string[] };

export const INIT_CONFIG_SERVICES_CONFLICT =
	"--no-config cannot be combined with --services.";

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

export const isBareInitServices = (
	services: readonly string[] | undefined,
): boolean => {
	if (services === undefined || services.length === 0) {
		return true;
	}
	return services.every((service) => service === "none");
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

export const shouldPullEnvAfterInitConfig = (input: {
	wroteNewFile: boolean;
	extraServices: boolean;
	alreadyPulled: boolean;
	projectId?: string;
	branch?: string;
}): boolean =>
	!input.extraServices &&
	!input.alreadyPulled &&
	shouldRefreshEnvAfterNewConfig({
		wroteNewFile: input.wroteNewFile,
		...(input.projectId !== undefined
			? { projectId: input.projectId }
			: {}),
		...(input.branch !== undefined ? { branch: input.branch } : {}),
	});
