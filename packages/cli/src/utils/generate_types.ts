import { getGeneratorMetadata } from "../vendor/postgres-meta/lib/generators.js";
import PostgresMeta from "../vendor/postgres-meta/lib/PostgresMeta.js";
import { apply as applyTypescriptTemplate } from "../vendor/postgres-meta/templates/typescript.js";
import { buildPoolConfig } from "./pg_pool_config.js";

export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export type GenerateTypesOptions = {
	connectionString: string;
	schemas: string[];
	detectOneToOneRelationships: boolean;
	/** Milliseconds. Bounds the client wait per query; defaults to 30s. */
	queryTimeout?: number;
};

type IntrospectionError = {
	message: string;
	code?: string;
	formattedError?: string;
};

const NO_SSL_SUPPORT = /does not support SSL/i;
const TLS_ERROR =
	/self[- ]signed|certificate|unable to verify|UNABLE_TO_|ERR_TLS|SSL/i;
const TIMEOUT_ERROR = /timeout|timed out|ETIMEDOUT/i;

const describeTarget = (connectionString: string): string => {
	try {
		const url = new URL(connectionString);
		return `${url.hostname}${url.pathname}`;
	} catch {
		return "the database";
	}
};

const withHints = (message: string): string => {
	if (TIMEOUT_ERROR.test(message)) {
		return `${message}\nHint: raise the limit with --query-timeout (for example 60s).`;
	}
	if (TLS_ERROR.test(message)) {
		return `${message}\nHint: trust a custom CA with sslrootcert=<file> in the URL, or use sslmode=no-verify to skip certificate verification.`;
	}
	return message;
};

const introspect = async (
	options: GenerateTypesOptions,
	overrideSsl: false | undefined,
): Promise<string> => {
	const { plaintextFallback: _fallback, ...poolConfig } = buildPoolConfig(
		options.connectionString,
	);
	const queryTimeout = options.queryTimeout ?? DEFAULT_QUERY_TIMEOUT_MS;
	const pgMeta = new PostgresMeta({
		...poolConfig,
		...(overrideSsl === false && { ssl: false }),
		query_timeout: queryTimeout,
		connectionTimeoutMillis: Math.min(
			DEFAULT_CONNECT_TIMEOUT_MS,
			queryTimeout,
		),
	});
	try {
		const { data: metadata, error } = await getGeneratorMetadata(pgMeta, {
			includedSchemas: options.schemas,
		});
		if (error) {
			throw Object.assign(new Error(error.message), {
				detail: error as IntrospectionError,
			});
		}
		return await applyTypescriptTemplate({
			...metadata,
			detectOneToOneRelationships: options.detectOneToOneRelationships,
		});
	} finally {
		await pgMeta.end();
	}
};

export const generateTypes = async (
	options: GenerateTypesOptions,
): Promise<string> => {
	const { plaintextFallback } = buildPoolConfig(options.connectionString);
	try {
		try {
			return await introspect(options, undefined);
		} catch (error) {
			const message = (error as Error).message;
			if (plaintextFallback && NO_SSL_SUPPORT.test(message)) {
				return await introspect(options, false);
			}
			throw error;
		}
	} catch (error) {
		const detail = (error as { detail?: IntrospectionError }).detail;
		if (detail === undefined) {
			throw error;
		}
		const body = (detail.formattedError ?? detail.message).trim();
		throw new Error(
			`Introspecting ${describeTarget(options.connectionString)} failed: ${withHints(body)}`,
		);
	}
};
