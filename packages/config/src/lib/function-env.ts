import { authoredFunctions } from "./authored-services.js";
import { ConfigValidationError } from "./errors.js";
import type { Config, FunctionEnvValue, FunctionEnvVar } from "./types.js";

/**
 * Where a declared value is resolved: a deploy to the project's default branch
 * (`production`), a deploy to any other branch (`preview`), or `neon dev` and `parseEnv`
 * (`development`).
 */
export type FunctionEnvTarget = "production" | "preview" | "development";

/** Where declared values are read from, usually `process.env`. */
export type FunctionEnvSource = Readonly<Record<string, string | undefined>>;

export interface ResolvedFunctionEnv {
	/** Values to set. On a deploy, `""` removes the deployed variable. */
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

function isRequired(
	declaration: FunctionEnvVar,
	target: FunctionEnvTarget,
): boolean {
	if (declaration.default !== undefined) return false;
	const required = declaration.required ?? true;
	return required === "production" ? target === "production" : required;
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
		} else if (declaration.default !== undefined) {
			env[key] = declaration.default;
		} else if (isRequired(declaration, target)) {
			missing.push(key);
		} else if (target !== "development") {
			env[key] = "";
		}
	}
	return { env, missing };
}

const MISSING_FIX: Record<FunctionEnvTarget, string> = {
	production: "Set it in the environment or in the file passed to --env.",
	preview:
		'Set it in the environment or in the file passed to --env, or declare it { required: "production" } if preview branches can run without it.',
	development:
		'Set it in .env.local, the environment, or the file passed to --env, or declare it { required: "production" } if only the production deployment needs it.',
};

/**
 * Throw one {@link ConfigValidationError} naming every declared variable `target` requires
 * that `source` lacks, across all of `config`'s functions.
 */
export function assertFunctionEnv(
	config: Pick<Config, "functions" | "preview">,
	source: FunctionEnvSource,
	target: FunctionEnvTarget,
): void {
	const issues = missingFunctionEnv(config, source, target).map(
		({ slug, key }) =>
			`Environment variable "${key}" for function "${slug}" is required and unset. ${MISSING_FIX[target]}`,
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
