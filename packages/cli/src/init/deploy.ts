import { isNeonApiError } from "../api.js";
import { recoverFrom401 } from "../auth_recovery.js";
import { ensureAuth } from "../commands/auth.js";
import { applyCmd } from "../commands/config.js";
import { contextBranch, readContextFile } from "../context.js";
import { log } from "../log.js";
import { authContext, type InitAuthOptions } from "./auth.js";
import {
	parseEnvAssignments,
	readTemplateInputs,
	resolveTemplateInputs,
	type TemplateInput,
	writeTemplateEnv,
} from "./template_inputs.js";

export type TemplateDeployOptions = InitAuthOptions & {
	/** The scaffolded template directory, already linked and installed. */
	cwd: string;
	/** `--env KEY=VALUE` values for the template's inputs. */
	env?: readonly string[];
	/** Asks for an input that has no value (interactive runs only). */
	ask?: (input: TemplateInput) => Promise<string | undefined>;
};

export type TemplateDeployResult = {
	envFile: string;
	/** Inputs given a generated value, such as API keys. Never their values. */
	generated: string[];
};

/**
 * `bootstrap --deploy`'s last step: write the template's inputs to `.env.local`, then
 * apply its `neon.ts` to the project `link` just created, the same way `neon deploy
 * --env .env.local` would. Its `deploy.after` hook (migrations, a smoke test) must
 * succeed too, so a failing hook fails the step instead of only warning.
 */
export const deployTemplate = async (
	options: TemplateDeployOptions,
): Promise<TemplateDeployResult> => {
	const { values, generated } = await resolveTemplateInputs(
		readTemplateInputs(options.cwd),
		{
			provided: parseEnvAssignments(options.env),
			...(options.ask ? { ask: options.ask } : {}),
		},
	);
	const envFile = writeTemplateEnv(options.cwd, values);
	if (generated.length > 0) {
		log.info(
			"Generated %s into .env.local (not printed).",
			generated.join(", "),
		);
	}

	const context = readContextFile(options.contextFile);
	const branch = contextBranch(context);
	if (!context.projectId || !branch) {
		throw new Error(
			"Can't deploy: the directory isn't linked to a Neon project. Run `neon link`, then `neon deploy --env .env.local`.",
		);
	}

	const authenticated = authContext(options, ["deploy"]);
	const apply = () =>
		inDirectory(options.cwd, () =>
			applyCmd({
				...authenticated,
				output: "table",
				projectId: context.projectId as string,
				branch,
				cwd: options.cwd,
				env: envFile,
				yes: true,
				envPull: true,
				strictHooks: true,
			}),
		);
	await ensureAuth(authenticated);
	try {
		await apply();
	} catch (error) {
		if (!isNeonApiError(error) || error.status !== 401) throw error;
		if (!(await recoverFrom401(true)))
			throw new Error("Authentication failed.");
		await ensureAuth(authenticated);
		await apply();
	}
	return { envFile, generated };
};

/**
 * Runs `run` with the template directory as the working directory. `config apply` resolves
 * function sources (and stages external packages) relative to `process.cwd()`, the way
 * `neon deploy` runs from the project root, so the deploy has to run from there too.
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
