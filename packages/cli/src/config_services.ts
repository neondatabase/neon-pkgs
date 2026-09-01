import type { DataApiSettings } from "@neon/config";
import type { Config } from "@neon/config-runtime";
import type { NeonService } from "./neon_services.js";

const isToggleEnabled = (
	toggle: boolean | { enabled?: boolean } | undefined,
): boolean => {
	if (toggle === undefined) return false;
	if (typeof toggle === "boolean") return toggle;
	return toggle.enabled !== false;
};

/** Postgres is omitted because every project includes it. */
export const declaredNeonServices = (config: Config): NeonService[] => {
	const services: NeonService[] = [];
	if (isToggleEnabled(config.auth)) services.push("auth");
	if (isToggleEnabled(config.dataApi)) services.push("data-api");
	if (Object.keys(config.preview?.buckets ?? {}).length > 0) {
		services.push("object-storage");
	}
	if (Object.keys(config.preview?.functions ?? {}).length > 0) {
		services.push("functions");
	}
	if (isToggleEnabled(config.preview?.aiGateway)) {
		services.push("ai-gateway");
	}
	return services;
};

export type ClaimableDataApiCreateBody = {
	auth_provider: "neon_auth" | "external";
	jwks_url?: string;
	provider_name?: string;
	jwt_audience?: string;
	settings?: Record<string, unknown>;
};

const dataApiSettingsToSnake = (
	settings: DataApiSettings,
): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	if (settings.dbAggregatesEnabled !== undefined) {
		out.db_aggregates_enabled = settings.dbAggregatesEnabled;
	}
	if (settings.dbAnonRole !== undefined) {
		out.db_anon_role = settings.dbAnonRole;
	}
	if (settings.dbExtraSearchPath !== undefined) {
		out.db_extra_search_path = settings.dbExtraSearchPath;
	}
	if (settings.dbMaxRows !== undefined) {
		out.db_max_rows = settings.dbMaxRows;
	}
	if (settings.dbSchemas !== undefined) {
		out.db_schemas = settings.dbSchemas;
	}
	if (settings.jwtRoleClaimKey !== undefined) {
		out.jwt_role_claim_key = settings.jwtRoleClaimKey;
	}
	if (settings.jwtCacheMaxLifetime !== undefined) {
		out.jwt_cache_max_lifetime = settings.jwtCacheMaxLifetime;
	}
	if (settings.openapiMode !== undefined) {
		out.openapi_mode = settings.openapiMode;
	}
	if (settings.serverCorsAllowedOrigins !== undefined) {
		out.server_cors_allowed_origins = settings.serverCorsAllowedOrigins;
	}
	if (settings.serverTimingEnabled !== undefined) {
		out.server_timing_enabled = settings.serverTimingEnabled;
	}
	return out;
};

/** Omitting this body preserves the server heuristic used by `--service data-api`. */
export const claimableDataApiCreateBody = (
	config: Config,
): ClaimableDataApiCreateBody | undefined => {
	if (!isToggleEnabled(config.dataApi)) return undefined;
	const input = config.dataApi;
	if (typeof input !== "object") {
		return { auth_provider: "neon_auth" };
	}
	const settings = input.settings
		? dataApiSettingsToSnake(input.settings)
		: undefined;
	const withSettings = (
		body: ClaimableDataApiCreateBody,
	): ClaimableDataApiCreateBody =>
		settings && Object.keys(settings).length > 0
			? { ...body, settings }
			: body;
	if (input.authProvider === "external") {
		if (input.jwksUrl === undefined || input.jwksUrl.length === 0) {
			throw new Error(
				'neon.ts dataApi.authProvider "external" requires dataApi.jwksUrl.',
			);
		}
		return withSettings({
			auth_provider: "external",
			jwks_url: input.jwksUrl,
			...(input.providerName !== undefined
				? { provider_name: input.providerName }
				: {}),
			...(input.jwtAudience !== undefined
				? { jwt_audience: input.jwtAudience }
				: {}),
		});
	}
	return withSettings({ auth_provider: "neon_auth" });
};
