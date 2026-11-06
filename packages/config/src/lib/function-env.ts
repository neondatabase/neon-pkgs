import { authoredFunctions } from "./authored-services.js";
import { ConfigValidationError } from "./errors.js";
import type { Config, FunctionEnvValue, FunctionEnvVar } from "./types.js";

/** `deploy` for `neon deploy` / `pushConfig`, `run` for `neon dev` and `parseEnv`. */
export type FunctionEnvTarget = "deploy" | "run";

/** Where declared values are read from, usually `process.env`. */
export type FunctionEnvSource = Readonly<Record<string, string | undefined>>;

export interface ResolvedFunctionEnv {
	/** Values to set. On `deploy`, `""` removes the deployed variable. */
	env: Record<string, string>;
	/** Declared keys `target` requires that `source` lacks. */
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

/** Resolve {@link FunctionEnvVar} declarations against `source` for `target`. */
export function resolveFunctionEnv(
	envVars: Record<string, FunctionEnvVar> | undefined,
	source: FunctionEnvSource,
	target: FunctionEnvTarget,
): ResolvedFunctionEnv {
	const env: Record<string, string> = {};
	const missing: string[] = [];
	for (const [key, declaration] of Object.entries(envVars ?? {})) {
		const value = source[key];
		if (value !== undefined && value !== "") {
			env[key] = value;
		} else if ("default" in declaration) {
			env[key] = declaration.default;
		} else if (declaration.required === true) {
			missing.push(key);
		} else if (declaration.required === "deploy") {
			if (target === "deploy") missing.push(key);
		} else if (target === "deploy" && declaration.ifUnset !== "keep") {
			env[key] = "";
		}
	}
	return { env, missing };
}

/**
 * Throw one {@link ConfigValidationError} naming every declared variable `target` requires
 * that `source` lacks, across all of `config`'s functions. Declarations are static, so this
 * runs before any branch is read or created.
 */
export function assertFunctionEnv(
	config: Pick<Config, "functions" | "preview">,
	source: FunctionEnvSource,
	target: FunctionEnvTarget,
): void {
	const fix =
		target === "deploy"
			? "Set it in the environment or in the file passed to --env."
			: 'Set it in .env.local, the environment, or the file passed to --env, or declare it { required: "deploy" } if only the deployed Function needs it.';
	const issues = missingFunctionEnv(config, source, target).map(
		({ slug, key }) =>
			`Environment variable "${key}" for function "${slug}" is required and unset. ${fix}`,
	);
	if (issues.length > 0) throw new ConfigValidationError(issues);
}

/** Every declared variable `target` requires that `source` lacks. */
export function missingFunctionEnv(
	config: Pick<Config, "functions" | "preview">,
	source: FunctionEnvSource,
	target: FunctionEnvTarget,
): { slug: string; key: string }[] {
	return Object.entries(authoredFunctions(config) ?? {}).flatMap(
		([slug, fn]) =>
			resolveFunctionEnv(
				splitFunctionEnv(fn.env).envVars,
				source,
				target,
			).missing.map((key) => ({ slug, key })),
	);
}
