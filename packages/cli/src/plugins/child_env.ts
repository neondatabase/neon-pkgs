const TELEMETRY_BLOCKERS = ["DISABLE_TELEMETRY", "DO_NOT_TRACK"] as const;
/**
 * `npm exec --package=…` and `npm exec -c …` export these to the process they start. Our nested
 * `npx` inherits them: `package` turns `plugins@<version>` into a literal command, and `call`
 * makes it refuse positional arguments.
 */
const PARENT_NPM_EXEC = ["NPM_CONFIG_PACKAGE", "NPM_CONFIG_CALL"];

/** The env the plugins CLI and the agent CLIs it calls run with. */
export const pluginsChildEnv = (
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
	const env = { ...base };
	// The plugins CLI needs its own install ping even though Neon records the parent command.
	for (const key of TELEMETRY_BLOCKERS) {
		delete env[key];
	}
	for (const key of Object.keys(env)) {
		const upper = key.toUpperCase();
		if (upper === "NEON_API_KEY" || PARENT_NPM_EXEC.includes(upper)) {
			delete env[key];
		}
	}
	return env;
};
