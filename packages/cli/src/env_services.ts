import { NEON_ENV_VAR_KEYS } from "@neon-internals/env-core/env";

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

/** Every OS-level env var `env pull` can write, in stable emit order. */
export const ENV_PULL_KEYS = [
	...Object.values(NEON_ENV_VAR_KEYS.postgres),
	NEON_ENV_VAR_KEYS.branch.name,
	...Object.values(NEON_ENV_VAR_KEYS.auth),
	...Object.values(NEON_ENV_VAR_KEYS.dataApi),
	...Object.values(NEON_ENV_VAR_KEYS.storage),
	...Object.values(NEON_ENV_VAR_KEYS.aiGateway),
] as const;
export type EnvPullKey = (typeof ENV_PULL_KEYS)[number];

/** The OS-level env vars each service contributes to a pulled `.env`. */
const SERVICE_ENV_KEYS: Record<NeonService, readonly EnvPullKey[]> = {
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

/** The service that produces a key, or `null` for branch identity. */
const ENV_KEY_SERVICE: Record<EnvPullKey, NeonService | null> = {
	DATABASE_URL: "postgres",
	DATABASE_URL_UNPOOLED: "postgres",
	NEON_BRANCH: null,
	NEON_AUTH_BASE_URL: "auth",
	NEON_AUTH_JWKS_URL: "auth",
	NEON_DATA_API_URL: "data-api",
	AWS_ACCESS_KEY_ID: "object-storage",
	AWS_SECRET_ACCESS_KEY: "object-storage",
	AWS_ENDPOINT_URL_S3: "object-storage",
	AWS_REGION: "object-storage",
	NEON_AI_GATEWAY_TOKEN: "ai-gateway",
	NEON_AI_GATEWAY_BASE_URL: "ai-gateway",
};

export const serviceForEnvKey = (key: EnvPullKey): NeonService | null =>
	ENV_KEY_SERVICE[key];

/** Services that must be resolved to produce the selected env keys. */
export const servicesForEnvKeys = (
	keys: readonly EnvPullKey[],
): NeonService[] =>
	ENV_PULL_SERVICES.filter((service) =>
		keys.some((key) => ENV_KEY_SERVICE[key] === service),
	);

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

/**
 * The exact env vars an explicit selection writes. Services contribute their complete
 * bundles plus branch identity; `--env` contributes only the named keys. The two selectors
 * compose as a union.
 */
export const envKeysForSelection = (
	services: readonly NeonService[],
	envKeys: readonly EnvPullKey[],
): EnvPullKey[] => {
	const selected =
		services.length > 0 ? envServiceKeys(services) : new Set<string>();
	for (const key of envKeys) selected.add(key);

	const hasStorageAccessKey = selected.has(
		NEON_ENV_VAR_KEYS.storage.accessKeyId,
	);
	const hasStorageSecret = selected.has(
		NEON_ENV_VAR_KEYS.storage.secretAccessKey,
	);
	if (hasStorageAccessKey !== hasStorageSecret) {
		throw new Error(
			"AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be selected together: " +
				"they are two halves of one newly issued object-storage credential. " +
				"Add the missing key to --env, or use --service object-storage.",
		);
	}

	return ENV_PULL_KEYS.filter((key) => selected.has(key));
};

/** Parse repeated or comma-separated `--env` values into canonical env-key order. */
export const parseEnvPullKeys = (
	raw: readonly string[],
	flag: string,
): EnvPullKey[] => {
	const names = raw
		.flatMap((value) => value.split(","))
		.map((name) => name.trim())
		.filter((name) => name !== "");
	const supported = `Supported values: ${ENV_PULL_KEYS.join(", ")}.`;
	if (names.length === 0) {
		throw new Error(
			`${flag} needs at least one env variable. ${supported}`,
		);
	}

	const unknown = names.filter(
		(name) => !ENV_PULL_KEYS.some((key) => key === name),
	);
	if (unknown.length > 0) {
		const displayNames = unknown.map(redactUnknownEnvValue);
		const suggestions = [
			...new Set(
				unknown
					.map(suggestEnvPullKey)
					.filter((key): key is EnvPullKey => key !== null),
			),
		];
		const suggestion =
			suggestions.length > 0
				? ` Did you mean ${suggestions.join(" or ")}?`
				: "";
		throw new Error(
			`Unknown env variable${unknown.length === 1 ? "" : "s"} ${displayNames.join(", ")}.${suggestion} ${supported}`,
		);
	}

	return ENV_PULL_KEYS.filter((key) => names.includes(key));
};

const redactUnknownEnvValue = (value: string): string => {
	const separator = value.indexOf("=");
	if (separator !== -1) {
		const key = value.slice(0, separator);
		return ENV_PULL_KEYS.some((supportedKey) => supportedKey === key)
			? `${key}=<redacted>`
			: "<redacted invalid value>";
	}
	return "<redacted invalid value>";
};

const suggestEnvPullKey = (value: string): EnvPullKey | null => {
	if (value.includes("=")) return null;
	const closest = ENV_PULL_KEYS.map(
		(key) => [key, editDistance(value, key)] as const,
	).sort((a, b) => a[1] - b[1])[0];
	return closest && closest[1] <= 2 ? closest[0] : null;
};

const editDistance = (left: string, right: string): number => {
	let previous = Array.from(
		{ length: right.length + 1 },
		(_, index) => index,
	);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		const current = [leftIndex];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			current[rightIndex] = Math.min(
				(previous[rightIndex] ?? 0) + 1,
				(current[rightIndex - 1] ?? 0) + 1,
				(previous[rightIndex - 1] ?? 0) +
					(left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[right.length] ?? right.length;
};

/** Narrow yargs' array option value without accepting any other runtime shape. */
export const envPullFlagValue = (value: unknown): string[] | undefined =>
	Array.isArray(value) ? value.map(String) : undefined;
