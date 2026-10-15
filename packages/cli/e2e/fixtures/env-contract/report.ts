import { parseEnv } from "@neon/env";
import config from "./neon.js";

const NEON_MANAGED_KEY =
	/^(DATABASE_URL|DATABASE_URL_UNPOOLED|NEON_BRANCH|NEON_AUTH_.+|NEON_DATA_API_.+|NEON_AI_GATEWAY_.+|NEON_FUNCTION_.+|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_ENDPOINT_URL_S3|AWS_REGION|PROBE_SETTING|PROBE_EXTRA)$/;

/** Values that are the same wherever they are read, and safe to return over HTTP. */
const PUBLIC_KEYS = [
	"NEON_BRANCH",
	"NEON_AUTH_BASE_URL",
	"NEON_AUTH_JWKS_URL",
	"NEON_DATA_API_URL",
	"NEON_AI_GATEWAY_BASE_URL",
	"AWS_ENDPOINT_URL_S3",
	"AWS_REGION",
	"NEON_FUNCTION_PROBE_BASE_URL",
	"PROBE_SETTING",
	"PROBE_EXTRA",
] as const;

export type ParseOutcome =
	| { ok: true; namespaces: string[] }
	| { ok: false; error: string };

export type EnvReport = {
	/** Names of the Neon-managed variables present. Never their values. */
	keys: string[];
	values: Partial<Record<(typeof PUBLIC_KEYS)[number], string>>;
	databaseHost: string | null;
	external: ParseOutcome;
	scoped: ParseOutcome;
};

function outcome(parse: () => object): ParseOutcome {
	try {
		return { ok: true, namespaces: Object.keys(parse()).sort() };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** What `parseEnv` makes of the current `process.env`, in every call form. */
export function envReport(): EnvReport {
	const values: EnvReport["values"] = {};
	for (const key of PUBLIC_KEYS) {
		const value = process.env[key];
		if (value !== undefined) values[key] = value;
	}
	const databaseUrl = process.env.DATABASE_URL;
	return {
		keys: Object.keys(process.env)
			.filter((key) => NEON_MANAGED_KEY.test(key))
			.sort(),
		values,
		databaseHost: databaseUrl ? new URL(databaseUrl).host : null,
		external: outcome(() => parseEnv(config)),
		scoped: outcome(() => parseEnv(config, "probe")),
	};
}
