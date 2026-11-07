import { existsSync } from "node:fs";
import { missingFunctionEnv } from "@neon/config";
import { isNeonApiError } from "../api.js";
import { recoverFrom401 } from "../auth_recovery.js";
import { ensureAuth } from "../commands/auth.js";
import { applyCmd } from "../commands/config.js";
import { contextBranch, readContextFile } from "../context.js";
import { loadEnvFileIntoProcess } from "../env_file.js";
import { loadProjectConfig } from "../project.js";
import { authContext, type InitAuthOptions } from "./auth.js";

export type InitDeployOptions = InitAuthOptions & {
	/** The scaffolded project directory, linked and installed. */
	cwd: string;
	/** The dotenv file `link` pulled into, loaded before neon.ts is evaluated. */
	envFile: string;
};

/**
 * The function env keys neon.ts reads that neither `envFile` nor the environment sets.
 * `neon deploy --env <envFile>` refuses to run until this is empty.
 */
export const missingDeployEnv = async (
	options: Pick<InitDeployOptions, "cwd" | "contextFile" | "envFile">,
): Promise<string[]> => {
	const applied = existsSync(options.envFile)
		? loadEnvFileIntoProcess(options.envFile)
		: [];
	try {
		const { config, omittedFunctionEnv } = await loadProjectConfig({
			cwd: options.cwd,
			contextFile: options.contextFile,
			unsetFunctionEnv: "omit",
		});
		// The linked branch is not read here, so `required: "default-branch"` counts as required.
		const declared = missingFunctionEnv(config, "deploy").map(
			({ key }) => key,
		);
		return [...new Set([...omittedFunctionEnv, ...declared])];
	} finally {
		for (const key of applied) delete process.env[key];
	}
};

/**
 * Runs `neon deploy --env <envFile>` in process against the branch `link` pinned, resolving
 * auth the way the standalone command does.
 */
export const deployInitProject = async (
	options: InitDeployOptions,
): Promise<void> => {
	const context = readContextFile(options.contextFile);
	const branch = contextBranch(context);
	const projectId = context.projectId;
	if (!projectId || !branch) {
		throw new Error(
			"Can't deploy: the directory isn't linked to a Neon project. Run `neon link`, then `neon deploy`.",
		);
	}
	const authenticated = authContext(options, ["deploy"]);
	const apply = () =>
		inDirectory(options.cwd, () =>
			applyCmd({
				...authenticated,
				output: "table",
				projectId,
				branch,
				cwd: options.cwd,
				...(existsSync(options.envFile)
					? { env: options.envFile }
					: {}),
			}),
		);
	await ensureAuth(authenticated);
	try {
		await apply();
		return;
	} catch (error) {
		if (!isNeonApiError(error) || error.status !== 401) throw error;
		if (!(await recoverFrom401(true))) {
			throw new Error("Authentication failed.");
		}
	}
	await ensureAuth(authenticated);
	await apply();
};

/**
 * `config apply` resolves function sources, bundles, and runs hooks relative to
 * `process.cwd()`, so the deploy runs from the project directory.
 */
const inDirectory = async <T>(
	dir: string,
	run: () => Promise<T>,
): Promise<T> => {
	const previous = process.cwd();
	process.chdir(dir);
	try {
		return await run();
	} finally {
		process.chdir(previous);
	}
};
