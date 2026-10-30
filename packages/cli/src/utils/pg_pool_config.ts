import { readFileSync } from "node:fs";
import { parse } from "pg-connection-string";
import type { PoolConfig } from "../vendor/postgres-meta/lib/types.js";

// pg 8.23 reads it; @types/pg 8.20 predates it.
export type NeonPoolConfig = PoolConfig & {
	enableChannelBinding?: boolean;
	/**
	 * Set for `sslmode=prefer`: if the server answers that it has no TLS, the
	 * caller retries the connection with `ssl: false`. node-postgres cannot fall
	 * back by itself.
	 */
	plaintextFallback?: boolean;
};

const UNSUPPORTED_CLIENT_CERT_PARAMS = ["sslcert", "sslkey", "sslca"];

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
 * `ssl=true|1` (Heroku/Prisma style) means a required TLS connection and
 * `ssl=false|0` means none; an explicit `sslmode` wins.
 */
const resolveSslMode = (
	sslmode: string | null,
	ssl: string | null,
): string | null => {
	if (sslmode !== null || ssl === null) {
		return sslmode;
	}
	if (ssl === "true" || ssl === "1") {
		return "require";
	}
	if (ssl === "false" || ssl === "0") {
		return "disable";
	}
	throw new Error(`Unsupported ssl "${ssl}". Use true, 1, false or 0.`);
};

/**
 * Builds the pg pool config from a connection URL without ever handing the URL's
 * `ssl*` parameters to pg or to the vendored `db.ts` `init`. `init` rewrites a
 * connection string's `sslmode` into `rejectUnauthorized = (sslmode === 'verify-full')`
 * and drops `sslrootcert`, which would leave Neon's `sslmode=require` URLs
 * unverified. `require`, `verify-ca` and `verify-full`
 * verify the server certificate; `no-verify` and `prefer` encrypt without verifying,
 * and `disable` and `allow` use plaintext.
 */
export const buildPoolConfig = (connectionString: string): NeonPoolConfig => {
	const url = new URL(connectionString);
	for (const param of UNSUPPORTED_CLIENT_CERT_PARAMS) {
		if (url.searchParams.has(param)) {
			throw new Error(
				"sslcert/sslkey/sslca are not supported by data-api gen-types; use sslrootcert for a custom CA",
			);
		}
	}
	const sslmode = resolveSslMode(
		url.searchParams.get("sslmode"),
		url.searchParams.get("ssl"),
	);
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
			// libpq tries plaintext first for `allow`.
			config.ssl = false;
			break;
		case "prefer":
			// libpq's `prefer` encrypts without authenticating the server.
			config.ssl = { rejectUnauthorized: false };
			config.plaintextFallback = true;
			break;
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
				`Unsupported sslmode "${sslmode}". Use disable, allow, prefer, require, verify-ca, verify-full or no-verify.`,
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
