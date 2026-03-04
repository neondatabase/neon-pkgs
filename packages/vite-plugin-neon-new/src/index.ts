import { resolve } from "node:path";
import { intro, log, outro } from "@clack/prompts";
import { instantPostgres } from "neon-new";
import { loadEnv, type Plugin } from "vite";

const DEFAULTS = {
	dotEnvFile: ".env",
	dotEnvKey: "DATABASE_URL",
	seed: undefined,
	envPrefix: "VITE_",
	settings: {
		logicalReplication: false,
	},
};

type PostgresPluginOptions = {
	referrer: string;
	dotEnvFile?: string;
	dotEnvKey?: string;
	seed?: {
		type: "sql-script";
		path: string;
	};
	envPrefix?: string;
	settings?: {
		logicalReplication?: boolean;
	};
};

let claimProcessStarted = false;

function postgresPlugin(options: PostgresPluginOptions): Plugin {
	if (!options?.referrer || options.referrer.trim() === "") {
		throw new Error(
			"vite-plugin-neon-new: 'referrer' option is required.\n\n" +
				"The referrer helps track usage for the Open Source Program.\n\n" +
				"Usage:\n" +
				"  postgres({ referrer: 'your-app-name' })\n\n" +
				"Examples:\n" +
				"  postgres({ referrer: 'github:username/repo-name' })\n" +
				"  postgres({ referrer: 'my-vite-app' })\n\n" +
				"For more information, visit: https://neon.com/docs/reference/instagres",
		);
	}

	const {
		dotEnvFile: envPath,
		dotEnvKey: envKey,
		referrer,
		seed,
		envPrefix,
		settings,
	} = {
		...DEFAULTS,
		...options,
		settings: {
			...DEFAULTS.settings,
			...options.settings,
		},
	};
	return {
		name: "vite-plugin-neon-new",
		enforce: "pre",

		async config({ root, envDir }, { mode }) {
			// Don't run in production to prevent accidental creation of a Neon database on CI
			if (mode === "production" || claimProcessStarted) return;

			const resolvedRoot = resolve(root ?? process.cwd());
			envDir = envDir ? resolve(resolvedRoot, envDir) : resolvedRoot;
			const resolvedEnvPath = resolve(
				envDir,
				envPath || DEFAULTS.dotEnvFile,
			);

			const envVars = loadEnv(mode, envDir, envKey);

			if (Object.keys(envVars).length > 0) {
				const envVar = envVars[envKey];
				if (!envVar) {
					log.info(
						`Environment variable ${envKey} not found in ${resolvedEnvPath}. We will create one for you.`,
					);
				} else {
					log.info(
						`Environment variable ${envKey} found in ${resolvedEnvPath}. If you wish to create a new Neon database, please remove the existing variable.`,
					);

					return;
				}
			}
			claimProcessStarted = true;

			intro("Setting up your project with a Neon database.");
			await instantPostgres({
				dotEnvFile: envPath,
				dotEnvKey: envKey,
				referrer: `npm:vite-plugin-neon-new|${referrer}`,
				seed,
				envPrefix,
				settings,
			});
			outro("Neon database created successfully.");
		},
	};
}

export { postgresPlugin as postgres };
export default postgresPlugin;
