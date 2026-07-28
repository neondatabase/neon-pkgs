/**
 * Path-parameter validation, applied before a URL is built.
 *
 * An empty path parameter produces a path with an empty segment — `/projects//branches`.
 * The Neon API's router canonicalises that with a **307 redirect before the request reaches
 * a handler**, so the 400 the spec implies is unreachable (LKB-14631). The redirect is
 * issued on the original method, and a client that cannot replay the request body across it
 * fails with an opaque transport error. The caller is then told "no response received from
 * the Neon API" when the truth is that they passed an empty project id.
 *
 * A missing parameter is just as broken: the serialiser leaves the `{name}` placeholder in
 * the URL. Both cases are refused here so the error names the parameter.
 */

import { NeonError } from "./errors.js";

/**
 * The name of the first path parameter that cannot be serialised into a valid URL, or
 * `undefined` when they are all usable. A parameter is unusable when it is absent, `null`,
 * or a string that is empty once trimmed.
 */
export function findUnusablePathParam(path: unknown): string | undefined {
	if (typeof path !== "object" || path === null) return undefined;

	for (const [name, value] of Object.entries(path)) {
		if (value === undefined || value === null) return name;
		if (typeof value === "string" && value.trim() === "") return name;
	}

	return undefined;
}

/** The `client`-kind error raised for an unusable path parameter. */
export function unusablePathParamError(name: string): NeonError {
	return new NeonError(
		`Path parameter "${name}" is missing or empty, so the request was not sent. ` +
			`The Neon API redirects paths containing an empty segment rather than rejecting ` +
			`them, which surfaces as an opaque network error instead of naming the parameter.`,
		"client",
	);
}

/**
 * Throw when any path parameter is unusable. Used as the client's `requestValidator`, which
 * runs for every request the ergonomic layer and the raw surface make through a client built
 * by `createNeonClient`.
 */
export function assertUsablePathParams(data: unknown): void {
	if (typeof data !== "object" || data === null) return;
	if (!("path" in data)) return;

	const name = findUnusablePathParam(data.path);
	if (name !== undefined) throw unusablePathParamError(name);
}
