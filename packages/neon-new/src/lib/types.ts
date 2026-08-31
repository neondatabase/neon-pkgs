export type SqlScript = {
	type: "sql-script";
	path: string;
};

/**
 * @deprecated Use Claimable Neon in the Neon CLI: `npx neon@latest claim create`.
 * Parameters for configuring Postgres database connection
 * @param {string} dotEnvFile - Path to the .env file where the connection string will be saved
 * @param {string} dotEnvKey - Environment variable name to store the connection string
 * @param {string} referrer - referrer name for tracking
 * @param {SqlScript} seed - Path to the `.sql` file to be pushed to the database
 * @param {string} envPrefix - Prefix for public environment variables (default: "PUBLIC_")
 * @param {Object} settings - Additional database settings
 * @param {boolean} settings.logicalReplication - Enable logical replication for the database (default: false)
 */
export interface InstantPostgresParams {
	dotEnvFile?: string;
	dotEnvKey?: string;
	referrer: string;
	seed?: SqlScript;
	envPrefix?: string;
	settings?: {
		logicalReplication?: boolean;
	};
}

export interface Defaults {
	dotEnvPath: string;
	dotEnvKey: string;
	seed?: SqlScript;
	envPrefix: string;
	referrer: string;
	settings: {
		logicalReplication: boolean;
	};
}
