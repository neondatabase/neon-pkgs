import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "./define-config.js";
import { ConfigLoadError } from "./errors.js";
import type { Config } from "./types.js";

/**
 * Default file names tried (in order) when {@link loadConfigFromFile} is called without an
 * explicit path. We accept `.ts` first because that's the documented format; `.mjs` and `.js`
 * fall out for free since jiti handles all of them.
 */
export const DEFAULT_CONFIG_FILENAMES = [
	"neon.ts",
	"neon.mts",
	"neon.js",
	"neon.mjs",
] as const;

export interface LoadConfigOptions {
	/** Explicit absolute or cwd-relative path to a config file. Takes precedence over the search. */
	path?: string;
	/** Starting directory for the upward search. Defaults to `process.cwd()`. */
	cwd?: string;
}

/**
 * Load a `neon.ts` (or any other supported extension) and return the validated {@link Config}.
 *
 * Behavior:
 * - When `path` is set, that file is loaded directly. The file must exist and must default-export
 *   a value produced by `defineConfig()`.
 * - When `path` is omitted, we walk up from `cwd` looking for the first file matching
 *   {@link DEFAULT_CONFIG_FILENAMES}. The walk stops at the same project-root markers as
 *   `findProjectContext` (`.git` or `package.json`).
 *
 * jiti is loaded lazily so that callers who pass an already-resolved `Config` to `pushConfig`
 * never pay the import cost.
 */
export async function loadConfigFromFile(
	options: LoadConfigOptions = {},
): Promise<{
	config: Config;
	resolvedPath: string;
}> {
	const resolvedPath = options.path
		? resolveExplicitPath(options.path, options.cwd)
		: findDefaultConfig(options.cwd);

	if (!resolvedPath) {
		throw new ConfigLoadError(
			`Could not find a Neon config file (looked for ${DEFAULT_CONFIG_FILENAMES.join(", ")}) in ${resolve(options.cwd ?? process.cwd())} or any parent directory.`,
		);
	}

	let mod: unknown;
	try {
		mod = await importModule(resolvedPath);
	} catch (cause) {
		throw new ConfigLoadError(
			`Failed to load ${resolvedPath}: ${(cause as Error)?.message ?? String(cause)}`,
			{
				cause,
			},
		);
	}

	const exported = extractDefaultExport(mod);
	if (exported === undefined) {
		throw new ConfigLoadError(
			`${resolvedPath} did not default-export a config. Export the result of \`defineConfig(...)\` as default.`,
		);
	}

	// Run through defineConfig to validate any object the user might have constructed manually.
	const config = defineConfig(exported as Config);
	return { config, resolvedPath };
}

function resolveExplicitPath(input: string, cwd?: string): string {
	const base = resolve(cwd ?? process.cwd());
	const abs = isAbsolute(input) ? input : resolve(base, input);
	if (!existsSync(abs)) {
		throw new ConfigLoadError(`Config file not found: ${abs}`);
	}
	const s = statSync(abs);
	if (!s.isFile()) {
		throw new ConfigLoadError(`Config path is not a file: ${abs}`);
	}
	return abs;
}

function findDefaultConfig(cwd: string | undefined): string | null {
	let current = resolve(cwd ?? process.cwd());
	let lastSeen: string | null = null;

	while (true) {
		for (const name of DEFAULT_CONFIG_FILENAMES) {
			const candidate = resolve(current, name);
			if (existsSync(candidate) && safeIsFile(candidate))
				return candidate;
		}

		if (
			existsSync(resolve(current, ".git")) ||
			existsSync(resolve(current, "package.json"))
		) {
			// Reached the project root without finding a config file.
			return null;
		}

		const parent = dirname(current);
		if (parent === current || parent === lastSeen) return null;
		lastSeen = current;
		current = parent;
	}
}

async function importModule(absPath: string): Promise<unknown> {
	const lower = absPath.toLowerCase();
	const needsJiti =
		lower.endsWith(".ts") ||
		lower.endsWith(".mts") ||
		lower.endsWith(".cts");

	if (!needsJiti) {
		return import(pathToFileURL(absPath).href);
	}

	const jitiModule: unknown = await import("jiti");
	const createJiti = extractCreateJiti(jitiModule);
	if (!createJiti) {
		throw new ConfigLoadError(
			"jiti is required to load TypeScript config files but could not be initialized",
		);
	}
	const jiti = createJiti(pathToFileURL(absPath).href, {
		interopDefault: true,
		moduleCache: false,
	});
	return jiti.import(absPath);
}

function extractCreateJiti(
	mod: unknown,
): ((id: string, options?: unknown) => JitiInstance) | null {
	if (mod === null || typeof mod !== "object") return null;
	const obj = mod as Record<string, unknown>;
	if (typeof obj.createJiti === "function") {
		return obj.createJiti as (
			id: string,
			options?: unknown,
		) => JitiInstance;
	}
	const def = obj.default;
	if (def !== null && typeof def === "object") {
		const defObj = def as Record<string, unknown>;
		if (typeof defObj.createJiti === "function") {
			return defObj.createJiti as (
				id: string,
				options?: unknown,
			) => JitiInstance;
		}
	}
	return null;
}

interface JitiInstance {
	import(id: string): Promise<unknown>;
}

function extractDefaultExport(mod: unknown): unknown {
	if (mod === null || typeof mod !== "object") return mod;
	const obj = mod as Record<string, unknown>;
	if ("default" in obj && obj.default !== undefined) return obj.default;
	// No `default` export. If the module shape itself looks like a Config (has `project`),
	// treat the module as the config — that lets tests and advanced users skip the wrapper.
	// Otherwise, return `undefined` so the caller surfaces a clear ConfigLoadError.
	if ("project" in obj) return mod;
	return undefined;
}

function safeIsFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
