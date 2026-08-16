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
