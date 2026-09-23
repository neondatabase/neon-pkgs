import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isNpmEnvKey = (key: string): boolean => {
	const lower = key.toLowerCase();
	return (
		lower.startsWith("npm_config_") ||
		lower === "node_auth_token" ||
		lower === "npm_token"
	);
};

/**
 * Keep registry auth when a test replaces HOME. Isolated agent detection
 * otherwise drops ~/.npmrc and `npx`/skills fail with E401 or hang.
 */
export const npmEnvForIsolatedHome = (): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || !isNpmEnvKey(key)) {
			continue;
		}
		env[key] = value;
	}
	if (
		env.npm_config_userconfig === undefined &&
		env.NPM_CONFIG_USERCONFIG === undefined
	) {
		const src = join(homedir(), ".npmrc");
		if (existsSync(src)) {
			env.npm_config_userconfig = src;
		}
	}
	return env;
};
