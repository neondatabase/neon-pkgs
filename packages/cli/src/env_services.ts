import { NEON_ENV_VAR_KEYS } from "@neon/env";

import { NEON_SERVICES, type NeonService } from "./neon_services.js";

/**
 * The services `env pull --service` can select: every Neon service that produces branch env
 * vars. `functions` is the one left out — a function's env comes from the local `neon.ts`,
 * never from the branch, so there is nothing to pull.
 */
export const ENV_PULL_SERVICES = NEON_SERVICES.filter(
	(service) => service !== "functions",
);

/** Why the services `env pull` leaves out are not selectable, for the refusal message. */
export const ENV_PULL_UNAVAILABLE: Partial<Record<NeonService, string>> = {
	functions:
		"a function's env comes from your neon.ts, not from the branch, so there is nothing to pull",
};

/** The OS-level env vars each service contributes to a pulled `.env`. */
const SERVICE_ENV_KEYS: Record<NeonService, readonly string[]> = {
	postgres: Object.values(NEON_ENV_VAR_KEYS.postgres),
	auth: Object.values(NEON_ENV_VAR_KEYS.auth),
	"data-api": Object.values(NEON_ENV_VAR_KEYS.dataApi),
	"object-storage": Object.values(NEON_ENV_VAR_KEYS.storage),
	"ai-gateway": Object.values(NEON_ENV_VAR_KEYS.aiGateway),
	functions: [],
};

/**
 * The subset of {@link SERVICE_ENV_KEYS} a pull *owns*, and so may prune from the target file
 * when the branch no longer has it. Object storage is deliberately absent: it is emitted under
 * the third-party `AWS_*` names, which collide with credentials a user may set by hand, so
 * `env pull` only ever writes them.
 */
const SERVICE_OWNED_ENV_KEYS: Record<NeonService, readonly string[]> = {
	...SERVICE_ENV_KEYS,
	"object-storage": [],
};

/**
 * Branch identity. Not a service — every branch has a name — so a scoped pull refreshes it
 * alongside whatever services were selected.
 */
export const BRANCH_ENV_KEY = NEON_ENV_VAR_KEYS.branch.name;

/** Every env var the selected services contribute, plus branch identity. */
export const envServiceKeys = (
	services: readonly NeonService[],
): Set<string> => {
	const keys = new Set<string>([BRANCH_ENV_KEY]);
	for (const service of services) {
		for (const key of SERVICE_ENV_KEYS[service]) keys.add(key);
	}
	return keys;
};

/**
 * The env vars a pull scoped to `services` may prune. Narrower than the unscoped set on
 * purpose: `env pull -s ai-gateway` says nothing about `DATABASE_URL`, so it must leave it
 * alone rather than treat its absence from this pull as "the branch no longer has it".
 */
export const ownedEnvServiceKeys = (
	services: readonly NeonService[],
): string[] => services.flatMap((service) => SERVICE_OWNED_ENV_KEYS[service]);
