import { authoredFunctions } from "./authored-services.js";
import { ConfigValidationError } from "./errors.js";
import type {
	BranchTarget,
	Config,
	FunctionEnvValue,
	FunctionEnvVar,
} from "./types.js";

/**
 * Where a declared value is resolved: a deploy to a known branch, a deploy whose branch is not
 * known yet (`"deploy"`, where `"default-branch"` counts as required), or `neon dev` and
 * `parseEnv` (`"development"`, where it counts as optional).
 */
export type FunctionEnvTarget = BranchTarget | "deploy" | "development";

export interface ResolvedFunctionEnv {
	/** Values to set. On a deploy, `""` removes the deployed variable. */
	env: Record<string, string>;
	/** Declared keys `target` requires whose value is unset. */
	missing: string[];
}

function isFunctionEnvVar(value: FunctionEnvValue): value is FunctionEnvVar {
	return typeof value === "object";
}

/** Separate a {@link FunctionDef.env} into literal values and declarations. */
export function splitFunctionEnv(
	env: Record<string, FunctionEnvValue> | undefined,
): { env: Record<string, string>; envVars?: Record<string, FunctionEnvVar> } {
	const literal: Record<string, string> = {};
	const declared: Record<string, FunctionEnvVar> = {};
	for (const [key, value] of Object.entries(env ?? {})) {
		if (isFunctionEnvVar(value)) declared[key] = value;
		else literal[key] = value;
	}
	return Object.keys(declared).length > 0
		? { env: literal, envVars: declared }
		: { env: literal };
}

function isRequired(
	declaration: FunctionEnvVar,
	target: FunctionEnvTarget,
): boolean {
	const { required } = declaration;
	if (typeof required === "boolean") return required;
	if (target === "development") return false;
	if (target === "deploy") return true;
	return target.isDefault === true;
}

/** Resolve {@link FunctionEnvVar} declarations for `target`. */
export function resolveFunctionEnv(
	envVars: Record<string, FunctionEnvVar> | undefined,
	target: FunctionEnvTarget,
): ResolvedFunctionEnv {
	const env: Record<string, string> = {};
	const missing: string[] = [];
	for (const [key, declaration] of Object.entries(envVars ?? {})) {
		const { value } = declaration;
		if (value !== undefined && value !== "") {
			env[key] = value;
		} else if (isRequired(declaration, target)) {
			missing.push(key);
		} else if (
			target !== "development" &&
			declaration.onUndefined !== "skip"
		) {
			env[key] = "";
		}
	}
	return { env, missing };
}

const DEPLOY_FIX = "Set it in the environment or in the file passed to --env.";
const DEVELOPMENT_FIX =
	'Set it in .env.local, the environment, or the file passed to --env, or declare it required: "default-branch" if only the default branch\'s deployment needs it.';

/**
 * Throw one {@link ConfigValidationError} naming every declared variable `target` requires
 * whose value is unset, across all of `config`'s functions.
 */
export function assertFunctionEnv(
	config: Pick<Config, "functions" | "preview">,
	target: FunctionEnvTarget,
): void {
	const issues = missingFunctionEnv(config, target).map(
		({ slug, key }) =>
			`Environment variable "${key}" for function "${slug}" is required and unset. ${target === "development" ? DEVELOPMENT_FIX : DEPLOY_FIX}`,
	);
	if (issues.length > 0) throw new ConfigValidationError(issues);
}

/** Every declared variable `target` requires whose value is unset. */
export function missingFunctionEnv(
	config: Pick<Config, "functions" | "preview">,
	target: FunctionEnvTarget,
): { slug: string; key: string }[] {
	return Object.entries(authoredFunctions(config) ?? {}).flatMap(
		([slug, fn]) =>
			resolveFunctionEnv(
				splitFunctionEnv(fn.env).envVars,
				target,
			).missing.map((key) => ({ slug, key })),
	);
}
