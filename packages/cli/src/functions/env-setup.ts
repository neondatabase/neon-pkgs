import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import prompts from "prompts";
import { ensureGitignored } from "../context.js";
import { mergeEnvFile, readEnvFile } from "../env_file.js";

export type EnvVarSpec = { name: string; description: string };

export type EnvSetupProps = {
	cwd: string;
	projectRoot: string;
	variables: EnvVarSpec[];
	interactive: boolean;
	noEnv?: boolean;
	envTo?: string;
	promptSecret?: (spec: EnvVarSpec) => Promise<string | undefined>;
};

export type EnvSetupPlan =
	| { kind: "skip" }
	| { kind: "cancelled" }
	| {
			kind: "write";
			path: string;
			relativePath: string;
			appends: Record<string, string>;
			present: string[];
			variables: string[];
	  };

export type EnvSetupOutcome = {
	path?: string;
	relativePath?: string;
	written: string[];
	present: string[];
	variables: string[];
};

const readIfExists = (path: string): Record<string, string> =>
	existsSync(path) ? readEnvFile(path) : {};

const defaultSecretPrompt = async (
	spec: EnvVarSpec,
): Promise<string | undefined> => {
	const answer = await prompts({
		type: "password",
		name: "value",
		message: `${spec.name} — ${spec.description}`,
	});
	return typeof answer.value === "string" ? answer.value : undefined;
};

const containedTarget = (projectRoot: string, envTo: string): string => {
	const abs = isAbsolute(envTo) ? envTo : resolve(projectRoot, envTo);
	const rel = relative(projectRoot, abs);
	if (
		rel === "" ||
		rel === ".." ||
		rel.startsWith(`..${sep}`) ||
		isAbsolute(rel)
	) {
		throw new Error(
			`--env-to ${envTo} is outside the project root ${projectRoot}.`,
		);
	}
	return abs;
};

const chooseTarget = (
	projectRoot: string,
	envTo: string | undefined,
	requiredKeys: string[],
): string => {
	if (envTo !== undefined) return containedTarget(projectRoot, envTo);
	const local = join(projectRoot, ".env.local");
	const dotenv = join(projectRoot, ".env");
	const holdsKey = (path: string): boolean =>
		existsSync(path) &&
		requiredKeys.some((key) => key in readEnvFile(path));
	if (holdsKey(local)) return local;
	if (holdsKey(dotenv)) return dotenv;
	if (existsSync(local)) return local;
	if (existsSync(dotenv)) return dotenv;
	return local;
};

export const planEnvSetup = async (
	props: EnvSetupProps,
): Promise<EnvSetupPlan> => {
	if (props.noEnv || props.variables.length === 0) return { kind: "skip" };
	const requiredKeys = props.variables.map((spec) => spec.name);
	const target = chooseTarget(props.projectRoot, props.envTo, requiredKeys);
	const present = new Set<string>();
	for (const path of [
		join(props.projectRoot, ".env"),
		join(props.projectRoot, ".env.local"),
		target,
	]) {
		const map = readIfExists(path);
		for (const key of requiredKeys) if (key in map) present.add(key);
	}
	const missing = props.variables.filter((spec) => !present.has(spec.name));
	if (missing.length > 0 && isTracked(props.projectRoot, target)) {
		throw new Error(
			`Refusing to write secrets to ${relative(props.cwd, target) || target}: it is tracked by git. Untrack it with \`git rm --cached ${relative(props.cwd, target) || target}\` (and add it to .gitignore), or pass --env-to <path> to an ignored file.`,
		);
	}
	const appends: Record<string, string> = {};
	for (const spec of missing) {
		if (props.interactive) {
			const value = await (props.promptSecret ?? defaultSecretPrompt)(
				spec,
			);
			if (value === undefined) return { kind: "cancelled" };
			appends[spec.name] = value;
		} else {
			appends[spec.name] = "";
		}
	}
	return {
		kind: "write",
		path: target,
		relativePath: relative(props.cwd, target) || target,
		appends,
		present: [...present],
		variables: requiredKeys,
	};
};

const isTracked = (root: string, path: string): boolean => {
	try {
		execFileSync("git", ["ls-files", "--error-unmatch", path], {
			cwd: root,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
};

export const applyEnvSetup = (plan: EnvSetupPlan): EnvSetupOutcome => {
	if (plan.kind !== "write") {
		return { written: [], present: [], variables: [] };
	}
	const written = Object.keys(plan.appends);
	if (written.length > 0) {
		mergeEnvFile(plan.path, plan.appends);
		ensureGitignored(plan.path);
	}
	return {
		path: plan.path,
		relativePath: plan.relativePath,
		written,
		present: plan.present,
		variables: plan.variables,
	};
};
