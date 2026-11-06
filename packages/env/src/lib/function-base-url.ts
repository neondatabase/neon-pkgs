/**
 * `functionBaseUrl` — the URL another Neon Function on the same branch answers at, built from
 * the variables the Functions runtime injects into every function, so a deployed function needs
 * no extra env. `neon env pull` writes the same variables locally and `neon dev` adds the
 * localhost port of each function it serves.
 */

import { ErrorCode, PlatformError } from "@neon/config/v1";
import {
	NEON_DEV_FUNCTION_PORTS,
	NEON_ENV_VAR_KEYS,
} from "@neon-internals/env-core/env";

/** The variables {@link functionBaseUrl} reads. `process.env` satisfies it. */
export type FunctionBaseUrlEnv = Readonly<Record<string, string | undefined>>;

const SLUG = /^[a-z0-9]{1,20}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The base URL of function `slug` on the current branch, without a trailing slash:
 * `https://<NEON_BRANCH_ID>-<slug><NEON_FUNCTION_HOST_SUFFIX>`, or `http://localhost:<port>`
 * when `neon dev` serves that function.
 *
 * @example
 * ```ts
 * import { functionBaseUrl } from "@neon/env";
 *
 * const res = await fetch(`${functionBaseUrl("hello")}/greet`);
 * ```
 *
 * @throws {TypeError} when `slug` is not a valid function slug (`[a-z0-9]{1,20}`).
 * @throws {PlatformError} `PLATFORM_ENV_NOT_INJECTED` when the variables are missing or do
 *   not form a valid hostname.
 */
export function functionBaseUrl(
	slug: string,
	env: FunctionBaseUrlEnv = process.env,
): string {
	if (!SLUG.test(slug)) {
		throw new TypeError(
			`functionBaseUrl: ${JSON.stringify(slug)} is not a function slug (1-20 lowercase letters and digits).`,
		);
	}

	const port = devFunctionPort(slug, env[NEON_DEV_FUNCTION_PORTS]);
	if (port !== undefined) return `http://localhost:${port}`;

	const K = NEON_ENV_VAR_KEYS.branch;
	const branchId = env[K.id];
	const suffix = env[K.functionHostSuffix];
	const missing = [
		...(branchId ? [] : [K.id]),
		...(suffix ? [] : [K.functionHostSuffix]),
	];
	if (!branchId || !suffix) {
		throw new PlatformError(
			ErrorCode.EnvNotInjected,
			[
				`functionBaseUrl: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set.`,
				"Deployed Neon Functions have them. Locally, run `neon env pull` or `neon dev`.",
			].join("\n"),
			{ details: { missing } },
		);
	}

	// Validated whole, so a malformed value cannot move the request to another authority
	// (`@`, `/`, `:` in either part) or produce a hostname DNS rejects.
	const label = `${branchId}-${slug}`;
	const hostname = `${label}${suffix}`;
	const suffixLabels = suffix.startsWith(".")
		? suffix.slice(1).split(".")
		: [];
	if (
		!DNS_LABEL.test(label) ||
		suffixLabels.length === 0 ||
		!suffixLabels.every((part) => DNS_LABEL.test(part)) ||
		hostname.length > 253
	) {
		throw new PlatformError(
			ErrorCode.EnvNotInjected,
			`functionBaseUrl: ${K.id}=${JSON.stringify(branchId)} and ${K.functionHostSuffix}=${JSON.stringify(suffix)} do not form a function hostname. Re-run \`neon env pull\`.`,
			{ details: { branchId, functionHostSuffix: suffix } },
		);
	}
	return `https://${hostname}`;
}

function devFunctionPort(
	slug: string,
	raw: string | undefined,
): number | undefined {
	if (raw === undefined) return undefined;
	let ports: unknown;
	try {
		ports = JSON.parse(raw);
	} catch {
		throw invalidDevPorts(raw);
	}
	if (typeof ports !== "object" || ports === null || Array.isArray(ports)) {
		throw invalidDevPorts(raw);
	}
	if (!Object.hasOwn(ports, slug)) return undefined;
	const port: unknown = Reflect.get(ports, slug);
	if (
		typeof port !== "number" ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	) {
		throw invalidDevPorts(raw);
	}
	return port;
}

function invalidDevPorts(raw: string): PlatformError {
	return new PlatformError(
		ErrorCode.EnvNotInjected,
		`functionBaseUrl: ${NEON_DEV_FUNCTION_PORTS}=${JSON.stringify(raw)} is not a JSON object of function ports. \`neon dev\` sets it; restart \`neon dev\`.`,
		{ details: { [NEON_DEV_FUNCTION_PORTS]: raw } },
	);
}
