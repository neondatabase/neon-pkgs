import { NEON_ENV_VAR_KEYS } from "@neon/env";

/**
 * A Neon service `env pull --service` can select, spelled the way a user types it.
 *
 * These are the branch-level services that produce env vars, so the set differs from
 * `config init --services` ({@link import("./config_template.js").NEON_SERVICES}): `postgres`
 * and `data-api` are here because they have env vars to pull, and `functions` is not — a
 * function's env comes from the local `neon.ts`, never from the branch.
 */
export const ENV_SERVICES = [
	"postgres",
	"auth",
	"data-api",
	"object-storage",
	"ai-gateway",
] as const;
export type EnvService = (typeof ENV_SERVICES)[number];

/** The OS-level env vars each service contributes to a pulled `.env`. */
const SERVICE_ENV_KEYS: Record<EnvService, readonly string[]> = {
	postgres: Object.values(NEON_ENV_VAR_KEYS.postgres),
	auth: Object.values(NEON_ENV_VAR_KEYS.auth),
	"data-api": Object.values(NEON_ENV_VAR_KEYS.dataApi),
	"object-storage": Object.values(NEON_ENV_VAR_KEYS.storage),
	"ai-gateway": Object.values(NEON_ENV_VAR_KEYS.aiGateway),
};

/**
 * The subset of {@link SERVICE_ENV_KEYS} a pull *owns*, and so may prune from the target file
 * when the branch no longer has it. Object storage is deliberately absent: it is emitted under
 * the third-party `AWS_*` names, which collide with credentials a user may set by hand, so
 * `env pull` only ever writes them.
 */
const SERVICE_OWNED_ENV_KEYS: Record<EnvService, readonly string[]> = {
	...SERVICE_ENV_KEYS,
	"object-storage": [],
};

/**
 * The one-time credential secrets each service's env carries. A branch credential is minted
 * once and its secrets live only in the user's env, so these are the keys
 * `fetchEnvReusingSecrets` inspects to decide whether it can reuse a credential — and, when it
 * cannot, which credential to revoke as superseded. Everything else a service emits
 * (endpoints, URLs, region) is plain branch metadata.
 */
const SERVICE_SECRET_ENV_KEYS: Record<EnvService, readonly string[]> = {
	postgres: [],
	auth: [],
	"data-api": [],
	"object-storage": [
		NEON_ENV_VAR_KEYS.storage.accessKeyId,
		NEON_ENV_VAR_KEYS.storage.secretAccessKey,
	],
	"ai-gateway": [NEON_ENV_VAR_KEYS.aiGateway.apiKey],
};

/**
 * Branch identity. Not a service — every branch has a name — so a scoped pull refreshes it
 * alongside whatever services were selected.
 */
export const BRANCH_ENV_KEY = NEON_ENV_VAR_KEYS.branch.name;

/**
 * Parse `--service` values into a canonical selection. Accepts the flag repeated
 * (`-s auth -s postgres`) and comma-separated values (`-s auth,postgres`), since both read
 * naturally and users will try either.
 *
 * Unknown names are rejected rather than dropped: a typo would otherwise pull everything
 * *except* the service that was asked for, and report success. The result is deduplicated and
 * ordered by {@link ENV_SERVICES}, so the written file does not depend on typing order.
 */
export const parseEnvServices = (raw: readonly string[]): EnvService[] => {
	const names = raw
		.flatMap((value) => value.split(","))
		.map((name) => name.trim())
		.filter((name) => name !== "");

	if (names.length === 0) {
		throw new Error(
			`--service needs at least one service. Supported values: ${ENV_SERVICES.join(", ")}.`,
		);
	}

	const unknown = names.filter(
		(name) => !ENV_SERVICES.includes(name as EnvService),
	);
	if (unknown.length > 0) {
		throw new Error(
			`Unknown service${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}. ` +
				`Supported values: ${ENV_SERVICES.join(", ")}.`,
		);
	}

	return ENV_SERVICES.filter((service) => names.includes(service));
};

/** Every env var the selected services contribute, plus branch identity. */
export const envServiceKeys = (
	services: readonly EnvService[],
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
	services: readonly EnvService[],
): string[] => services.flatMap((service) => SERVICE_OWNED_ENV_KEYS[service]);

/**
 * The credential secrets of the services a scoped pull did *not* select.
 *
 * These have to be hidden from the resolver. Object storage and the AI Gateway share one
 * branch credential, and `fetchEnvReusingSecrets` revokes whatever the persisted secrets name
 * once it decides to mint a replacement — so a pull scoped to one of them would revoke the
 * other's credential while a scoped prune keeps the other's now-dead vars on disk. Hiding the
 * secrets leaves the unselected service's credential untouched and its vars working.
 */
export const unselectedSecretEnvKeys = (
	services: readonly EnvService[],
): string[] =>
	ENV_SERVICES.filter((service) => !services.includes(service)).flatMap(
		(service) => SERVICE_SECRET_ENV_KEYS[service],
	);
