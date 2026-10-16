import { readFileSync } from "node:fs";
import { parse } from "pg-connection-string";
import type { PoolConfig } from "../vendor/postgres-meta/lib/types.js";

// pg 8.23 reads it; @types/pg 8.20 predates it.
export type NeonPoolConfig = PoolConfig & { enableChannelBinding?: boolean };

const SSL_PARAMS = [
	"ssl",
	"sslmode",
	"sslrootcert",
	"sslca",
	"sslcert",
	"sslkey",
	"sslnegotiation",
	"uselibpqcompat",
	"channel_binding",
];

/**
 * Builds the pg pool config from a connection URL without ever handing the URL's
 * `ssl*` parameters to pg or to the vendored `db.ts` `init`. `init` rewrites a
 * connection string's `sslmode` into `rejectUnauthorized = (sslmode === 'verify-full')`
 * and drops `sslrootcert`, which would leave Neon's `sslmode=require` URLs
 * unverified. Every mode except `disable` and `no-verify` verifies the server
 * certificate; `no-verify` is the only explicit opt-out.
 */
export const buildPoolConfig = (connectionString: string): NeonPoolConfig => {
	const url = new URL(connectionString);
	const sslmode = url.searchParams.get("sslmode");
	const sslrootcert = url.searchParams.get("sslrootcert");
	const channelBinding = url.searchParams.get("channel_binding");
	for (const param of SSL_PARAMS) {
		url.searchParams.delete(param);
	}

	const { ssl: _ssl, port, ...parsed } = parse(url.toString());
	const config: NeonPoolConfig = {
		...parsed,
		host: parsed.host ?? undefined,
		database: parsed.database ?? undefined,
		port: port ? Number(port) : undefined,
	};

	switch (sslmode) {
		case null:
			break;
		case "disable":
			config.ssl = false;
			break;
		case "no-verify":
			config.ssl = { rejectUnauthorized: false };
			break;
		case "allow":
		case "prefer":
		case "require":
		case "verify-ca":
		case "verify-full": {
			const ca =
				sslrootcert && sslrootcert !== "system"
					? readFileSync(sslrootcert, "utf8")
					: undefined;
			config.ssl = {
				rejectUnauthorized: true,
				...(ca !== undefined && { ca }),
				// libpq's verify-ca checks the chain only. Without a pinned CA that
				// would trust any certificate from a public CA, so it keeps the
				// hostname check then.
				...(sslmode === "verify-ca" && ca !== undefined
					? { checkServerIdentity: () => undefined }
					: {}),
			};
			break;
		}
		default:
			throw new Error(
				`Unsupported sslmode "${sslmode}". Use disable, require, verify-ca, verify-full or no-verify.`,
			);
	}

	if (channelBinding === "require") {
		if (config.ssl === undefined || config.ssl === false) {
			throw new Error(
				"channel_binding=require needs TLS, but sslmode disables it",
			);
		}
		config.enableChannelBinding = true;
	} else if (
		channelBinding !== null &&
		channelBinding !== "prefer" &&
		channelBinding !== "disable"
	) {
		throw new Error(
			`Unsupported channel_binding "${channelBinding}". Use require, prefer or disable.`,
		);
	}

	return config;
};
