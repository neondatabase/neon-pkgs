const TELEMETRY_BLOCKERS = ["DISABLE_TELEMETRY", "DO_NOT_TRACK"] as const;

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
		if (key.toUpperCase() === "NEON_API_KEY") {
			delete env[key];
		}
	}
	return env;
};
