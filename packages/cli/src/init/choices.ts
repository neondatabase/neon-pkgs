import { functionBaseUrlKey } from "@neon-internals/env-core/env";
import { FUNCTION_SLUG } from "../config_template.js";
import type { EnvPullKey } from "../env_services.js";
import type { NeonService } from "../neon_services.js";

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
		return { kind: "write", services: ["postgres"] };
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

/**
 * A neon.ts policy pull fails while the branch lacks a declared service. These two need
 * no `deploy`: the AI Gateway exists on every branch, and function URLs derive from the
 * branch host.
 */
const DEPLOY_FREE_SERVICES: ReadonlySet<NeonService> = new Set([
	"ai-gateway",
	"functions",
]);

const needsDeploy = (declared: readonly NeonService[]): boolean =>
	declared.some((service) => !DEPLOY_FREE_SERVICES.has(service));

export type InitEnvPull =
	| { kind: "skip" }
	/** Resolve from neon.ts when present, else from the branch's live state. */
	| { kind: "policy" }
	| { kind: "services"; services: NeonService[]; envKeys: EnvPullKey[] };

export const initEnvPullAfterConfig = (input: {
	/** Init linked in this run and left the env pull until neon.ts exists. */
	linkDeferredPull: boolean;
	wroteNewFile: boolean;
	/** Services the new neon.ts declares beyond Postgres. */
	declared: readonly NeonService[];
	claimable: boolean;
	projectId?: string;
	branch?: string;
}): InitEnvPull => {
	if (!input.projectId || !input.branch) {
		return { kind: "skip" };
	}
	if (!input.linkDeferredPull && !input.wroteNewFile) {
		return { kind: "skip" };
	}
	if (input.claimable && input.declared.length > 0) {
		return { kind: "skip" };
	}
	if (!needsDeploy(input.declared)) {
		return { kind: "policy" };
	}
	return {
		kind: "services",
		services: input.declared.includes("ai-gateway")
			? ["postgres", "ai-gateway"]
			: ["postgres"],
		// `--service functions` needs a deployed function; the scaffolded one's URL does not.
		envKeys: input.declared.includes("functions")
			? [functionBaseUrlKey(FUNCTION_SLUG)]
			: [],
	};
};
