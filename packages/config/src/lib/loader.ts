import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
	/**
	 * Hard ceiling for the upward walk — once `current === stopAt` the search returns
	 * `null` even if no `.git` boundary was hit. Defaults to the OS home directory so
	 * stray runs from outside any repo never leak into the user's `~` files.
	 */
	stopAt?: string;
}

/**
 * Load a `neon.ts` (or any other supported extension) and return the validated {@link Config}.
 *
 * Behavior:
 * - When `path` is set, that file is loaded directly. The file must exist and must default-export
 *   a value produced by `defineConfig()`.
 * - When `path` is omitted, we walk up from `cwd` picking the **closest** file matching
 *   {@link DEFAULT_CONFIG_FILENAMES}. The walk is monorepo-friendly: intermediate
 *   `package.json` files do **not** stop it, so a single `neon.ts` lifted to the workspace
 *   root keeps working when invoked from inside any sub-package. The walk terminates at the
 *   first directory containing `.git`, at `stopAt`, or at the filesystem root.
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
		: findDefaultConfig(options.cwd, options.stopAt);

	if (!resolvedPath) {
		throw new ConfigLoadError(
			[
				`Could not find a Neon config file while walking up from ${resolve(options.cwd ?? process.cwd())}.`,
				`Looked for: ${DEFAULT_CONFIG_FILENAMES.join(", ")} (stopping at the first directory with a \`.git\`).`,
				`Create one at your repository root (or anywhere on the path from cwd up to .git), or pass an explicit \`configPath\` (SDK) / \`--config <path>\` (CLI).`,
			].join("\n"),
		);
	}

	let mod: unknown;
	try {
		mod = await importModule(resolvedPath);
	} catch (cause) {
		throw new ConfigLoadError(
			[
				`Failed to evaluate ${resolvedPath}.`,
				`Underlying error: ${(cause as Error)?.message ?? String(cause)}`,
				"This is usually a TypeScript syntax error, a missing dependency, or a runtime exception inside the config file. Run the file directly (e.g. `npx tsx neon.ts`) to reproduce.",
			].join("\n"),
			{ cause },
		);
	}

	const exported = extractDefaultExport(mod);
	if (exported === undefined) {
		throw new ConfigLoadError(
			[
				`${resolvedPath} loaded successfully but did not default-export a config.`,
				"Add `export default defineConfig({ ... })` at the bottom of the file. (Named exports are ignored.)",
			].join("\n"),
		);
	}

	// Run through defineConfig to validate any function the user might have constructed manually.
	const config = defineConfig(exported as Config);
	return { config, resolvedPath };
}

function resolveExplicitPath(input: string, cwd?: string): string {
	const base = resolve(cwd ?? process.cwd());
	const abs = isAbsolute(input) ? input : resolve(base, input);
	if (!existsSync(abs)) {
		throw new ConfigLoadError(
			`Config file not found at ${abs}. The path was resolved from \`${input}\` against ${base}.`,
		);
	}
	const s = statSync(abs);
	if (!s.isFile()) {
		throw new ConfigLoadError(
			`Config path ${abs} is a directory, not a file. Pass a path to the file itself (e.g. ./neon.ts).`,
		);
	}
	return abs;
}

function findDefaultConfig(
	cwd: string | undefined,
	stopAt: string | undefined,
): string | null {
	let current = resolve(cwd ?? process.cwd());
	const stop = resolve(stopAt ?? homedir());
	let lastSeen: string | null = null;

	while (true) {
		for (const name of DEFAULT_CONFIG_FILENAMES) {
			const candidate = resolve(current, name);
			if (existsSync(candidate) && safeIsFile(candidate))
				return candidate;
		}

		// `.git` is the canonical repo-root marker. `package.json` is deliberately *not*
		// a stop: monorepos lift `neon.ts` above sub-package package.jsons.
		if (existsSync(resolve(current, ".git"))) return null;
		if (current === stop) return null;

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
			[
				"jiti is required to load TypeScript config files but could not be initialised.",
				"Reinstall the package dependencies (`pnpm install` / `npm install`) — jiti is a runtime dependency of @neondatabase/config.",
			].join(" "),
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
	// No `default` export. If the module itself is a function, treat it as the config —
	// that lets tests and advanced users skip the wrapper.
	// Otherwise, return `undefined` so the caller surfaces a clear ConfigLoadError.
	if (typeof mod === "function") return mod;
	return undefined;
}

function safeIsFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
