import { execa } from "execa";

import pkg from "../pkg.js";

const TELEMETRY_BLOCKERS = ["DISABLE_TELEMETRY", "DO_NOT_TRACK"] as const;

export type SkillsMetadataCommand = "skills";

export const skillsMetadata = (command: SkillsMetadataCommand): string =>
	JSON.stringify({
		origin: "neon-cli",
		command,
		version: pkg.version,
	});

export const skillsChildEnv = (
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
	const env = { ...base };
	// Neon already telemeters this command. The skills CLI still needs its
	// own install ping, so drop the blockers a parent shell may have set.
	for (const key of TELEMETRY_BLOCKERS) {
		delete env[key];
	}
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === "NEON_API_KEY") {
			delete env[key];
		}
	}
	return env;
};

export const SKILLS_MIN_NODE = "22.20.0";

const nodeParts = (version: string): [number, number, number] => {
	const [major, minor, patch] = version
		.replace(/^v/, "")
		.split(".")
		.map((part) => Number.parseInt(part, 10));
	return [
		Number.isInteger(major) ? major : 0,
		Number.isInteger(minor) ? minor : 0,
		Number.isInteger(patch) ? patch : 0,
	];
};

export const nodeMeetsMinimum = (current: string, minimum: string): boolean => {
	const left = nodeParts(current);
	const right = nodeParts(minimum);
	for (let i = 0; i < 3; i += 1) {
		const a = left[i];
		const b = right[i];
		if (a === undefined || b === undefined) {
			return false;
		}
		if (a !== b) {
			return a > b;
		}
	}
	return true;
};

export const assertSkillsNode = (version = process.version): void => {
	if (nodeMeetsMinimum(version, SKILLS_MIN_NODE)) {
		return;
	}
	throw new Error(
		`neon skills needs Node.js ${SKILLS_MIN_NODE} or newer to run the skills CLI. This process is Node.js ${version.replace(/^v/, "")}. Upgrade Node.js, then retry.`,
	);
};

export const skillsAddArgs = (options: {
	source: string;
	skills: readonly string[];
	agents: readonly string[];
	global: boolean;
	metadata: string;
}): string[] => {
	if (options.skills.length === 0) {
		throw new Error("skills add needs at least one --skill.");
	}
	const args = ["-y", "skills", "add", options.source];
	for (const skill of options.skills) {
		args.push("--skill", skill);
	}
	for (const agent of options.agents) {
		args.push("--agent", agent);
	}
	if (options.global) {
		args.push("-g");
	}
	args.push("-y", "--metadata", options.metadata);
	return args;
};

export const neonSkillsRetryCommand = (options: {
	skills: readonly string[];
	agents: readonly string[];
	global: boolean;
}): string => {
	const args = ["skills"];
	for (const skill of options.skills) {
		args.push("-s", skill);
	}
	for (const agent of options.agents) {
		args.push("--agent", agent);
	}
	if (options.global) {
		args.push("--global");
	}
	args.push("-y");
	return `neon ${args.map(quoteNpxArg).join(" ")}`;
};

export const neonSkillsUpdateRetryCommand = (global: boolean): string =>
	global ? "neon skills update --global -y" : "neon skills update -y";

export const quoteNpxArg = (part: string): string =>
	/[\s"'\\*]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part;

export const npxCommand = (args: readonly string[]): string =>
	`npx ${args.map(quoteNpxArg).join(" ")}`;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const UPDATE_BANNER = /^Checking for skill updates/i;
const UPDATE_NOTHING =
	/No (?:project|global) skills (?:to update|to check|tracked in lock file|can be updated in place)|All global skills are up to date/i;
const UPDATE_RESULT =
	/No (?:project|global) skills (?:to update|to check|tracked in lock file|can be updated in place)\.?|All global skills are up to date|(?:✓\s*)?Updated \d+ skills?(?:\(s\))?|(?:✗\s*)?Failed to update \d+ skills?(?:\(s\))?/i;

const stripAnsi = (text: string): string =>
	text.replace(ANSI, "").replace(/\r/g, "");

export const skillsUpdateHadNothing = (output: string): boolean =>
	UPDATE_NOTHING.test(stripAnsi(output));

export const skillsUpdateDetail = (output: string): string | undefined => {
	const text = stripAnsi(output);
	let last: string | undefined;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (UPDATE_RESULT.test(trimmed)) {
			last = trimmed;
		}
	}
	if (last !== undefined) {
		return last;
	}
	for (const line of text.split("\n").reverse()) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || UPDATE_BANNER.test(trimmed)) {
			continue;
		}
		return trimmed;
	}
	return undefined;
};

export const skillsUpdateArgs = (options: { global: boolean }): string[] => [
	"-y",
	"skills",
	"update",
	options.global ? "-g" : "-p",
	"-y",
];

export type SkillsRunResult = {
	stdout: string;
	stderr: string;
};

export const runSkillsCli = async (options: {
	args: readonly string[];
	cwd: string;
}): Promise<SkillsRunResult> => {
	assertSkillsNode();
	try {
		const result = await execa("npx", options.args, {
			cwd: options.cwd,
			env: skillsChildEnv(),
			// extendEnv would copy DISABLE_TELEMETRY / DO_NOT_TRACK back in.
			extendEnv: false,
			stdio: "pipe",
			timeout: 120_000,
		});
		return { stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		if (isCommandMissing(error)) {
			throw new Error(
				"neon skills needs npx (Node.js) to run the skills CLI. Install Node.js, then retry.",
			);
		}
		if (isExecaFailure(error)) {
			const childOut = [error.stderr, error.stdout]
				.filter((part) => typeof part === "string" && part.length > 0)
				.join("\n");
			const detail = childOut.length > 0 ? childOut : error.shortMessage;
			throw new Error(
				detail.length > 0
					? `skills CLI failed:\n${detail}`
					: "skills CLI failed.",
			);
		}
		throw error;
	}
};

const isCommandMissing = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === "ENOENT";

const isExecaFailure = (
	error: unknown,
): error is {
	stderr: string;
	stdout: string;
	shortMessage: string;
} =>
	typeof error === "object" &&
	error !== null &&
	"shortMessage" in error &&
	typeof error.shortMessage === "string";
