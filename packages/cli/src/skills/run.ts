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
	return env;
};

export const skillsAddArgs = (options: {
	source: string;
	skills: "*" | readonly string[];
	agents: readonly string[];
	global: boolean;
	metadata: string;
}): string[] => {
	const args = ["-y", "skills", "add", options.source];
	if (options.skills === "*") {
		args.push("--skill", "*");
	} else if (options.skills.length === 0) {
		throw new Error("skills add needs at least one --skill.");
	} else {
		for (const skill of options.skills) {
			args.push("--skill", skill);
		}
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

export const quoteNpxArg = (part: string): string =>
	/[\s"'\\*]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part;

export const npxCommand = (args: readonly string[]): string =>
	`npx ${args.map(quoteNpxArg).join(" ")}`;

export const firstChildLine = (output: string): string | undefined => {
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return undefined;
};

export const skillsUpdateHadNothing = (output: string): boolean =>
	/No (?:project|global) skills to update/i.test(output);

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
				"neon skills needs npx (Node.js) to run the skills CLI (`npx skills add neondatabase/agent-skills`). Install Node.js, then retry.",
			);
		}
		if (isExecaFailure(error)) {
			const detail = [error.stderr, error.stdout, error.shortMessage]
				.filter((part) => typeof part === "string" && part.length > 0)
				.join("\n");
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
