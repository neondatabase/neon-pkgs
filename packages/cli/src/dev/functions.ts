import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	assertFunctionEnv,
	authoredFunctions,
	type Config,
	type FunctionBundlerInput,
	type FunctionDevConfig,
	type ResolvedFunctionConfig,
	resolveConfig,
	resolveFunctionEnv,
} from "@neon/config";
import { loadProjectConfig } from "../project.js";

/**
 * A function from `neon.ts`, resolved into everything `neon dev` needs to serve it
 * locally. `source` is absolute (resolved against the `neon.ts` location). `port` is the
 * function's explicit `dev.port`, or `undefined` to let the supervisor find a free one.
 * `env` is the function's own `neon.ts` env, layered over the shared branch env per child.
 */
export type PlannedFunction = {
	slug: string;
	name: string;
	source: string;
	port?: number;
	env: Record<string, string>;
	/** The part of {@link env} resolved from `{ required: … }` / `{ default }` declarations. */
	declaredEnv?: Record<string, string>;
	/** Declared keys that resolved unset, removed from the inherited environment. */
	unsetEnv?: string[];
	/**
	 * The function's `neon.ts` `externalPackages`, mirrored so a local bundle is built with
	 * the same `external` list as a deploy. Without it, `neon dev` would fail to bundle a
	 * function that deploys fine — the failure `externalPackages` exists to fix.
	 */
	externalPackages?: string[];
	bundler?: FunctionBundlerInput;
};

/**
 * The result of resolving `neon.ts`: the path to the config file that was loaded (so the
 * dev server can watch it for hot-add/remove of functions) plus the {@link PlannedFunction}s
 * it declares.
 */
export type ResolvedConfigFunctions = {
	/** Absolute path to the loaded `neon.ts` (or `.mts`/`.js`/`.mjs`). */
	configPath: string;
	functions: PlannedFunction[];
};

/**
 * Load `neon.ts` (if any) and resolve the list of functions it declares into
 * {@link PlannedFunction}s for `neon dev` to serve. Returns `null` when there is no
 * `neon.ts` on the path from `cwd` up to the repo root — the caller turns that into a
 * "no --source and no neon.ts" error.
 *
 * `branchName` is used only to evaluate a policy that switches on `branch.name`; the
 * function list is otherwise branch-independent, so a placeholder is fine when unknown.
 */
export const resolveFunctionsFromConfig = async (
	cwd: string,
	branchName?: string,
	contextFile?: string,
): Promise<ResolvedConfigFunctions | null> => {
	const loaded = await loadNeonConfig(cwd, contextFile);
	if (!loaded) return null;

	const { config, configDir, configPath } = loaded;
	assertFunctionEnv(config, process.env, "run");
	const resolved = resolveConfig(config, {
		name: branchName ?? "local",
		exists: branchName !== undefined,
	});

	const functions = resolved.preview?.functions ?? [];
	const planned = functions.map((fn) => {
		const source = resolveFunctionSource(fn.source, configDir);
		if (!existsSync(source)) {
			throw new Error(
				`Function "${fn.slug}" points at a source that does not exist: ${source} ` +
					`(from neon.ts "${fn.source}"). Fix the source path and re-run.`,
			);
		}
		return toPlannedFunction(fn, source);
	});

	return { configPath, functions: planned };
};

/**
 * The neon.ts function whose `source` is this file, if any. Sibling sources are not
 * required to exist: `neon dev --source` is serving one file, not the whole set.
 */
export const findConfigFunctionBySource = async (
	cwd: string,
	source: string,
	contextFile?: string,
): Promise<PlannedFunction | undefined> => {
	const loaded = await loadNeonConfig(cwd, contextFile);
	if (!loaded) return undefined;

	const resolved = resolveConfig(loaded.config, {
		name: "local",
		exists: false,
	});
	const functions = resolved.preview?.functions ?? [];
	const match = functions.find(
		(fn) => resolveFunctionSource(fn.source, loaded.configDir) === source,
	);
	if (!match) return undefined;
	// Siblings are not served, so only the matched function's secrets are required.
	const served = Object.entries(
		authoredFunctions(loaded.config) ?? {},
	).filter(([slug]) => slug === match.slug);
	assertFunctionEnv(
		{ functions: Object.fromEntries(served) },
		process.env,
		"run",
	);
	return toPlannedFunction(match, source);
};

const resolveFunctionSource = (source: string, configDir: string): string =>
	isAbsolute(source) ? source : resolve(configDir, source);

const toPlannedFunction = (
	fn: ResolvedFunctionConfig,
	source: string,
): PlannedFunction => {
	const port = devPort(fn.dev);
	const declaredEnv = resolveFunctionEnv(fn.envVars, process.env, "run").env;
	const unsetEnv = Object.keys(fn.envVars ?? {}).filter(
		(key) => !(key in declaredEnv),
	);
	return {
		slug: fn.slug,
		name: fn.name,
		source,
		...(port !== undefined ? { port } : {}),
		env: { ...fn.env, ...declaredEnv },
		declaredEnv,
		...(unsetEnv.length > 0 ? { unsetEnv } : {}),
		// Names only: locally every entry is simply left unbundled, and `includeFiles`
		// governs the deployed archive, which `neon dev` does not build.
		...(fn.externalPackages
			? {
					externalPackages: fn.externalPackages.map(
						(pkg) => pkg.name,
					),
				}
			: {}),
		...(fn.bundler !== "esbuild" ? { bundler: fn.bundler } : {}),
	};
};

/**
 * Read the `port` off a {@link FunctionDevConfig}. `undefined` when no `dev.port` is set
 * (the supervisor then searches for a free port).
 */
const devPort = (dev: FunctionDevConfig | undefined): number | undefined =>
	dev?.port;

type LoadedConfig = { config: Config; configDir: string; configPath: string };

/**
 * Load a `neon.ts` policy if one exists, returning the loaded config, the resolved path to
 * the config file (used by the dev server to watch it), and the directory it lives in (used
 * to resolve each function's relative `source`). Returns `null` when no config file is
 * found; surfaces real load errors (e.g. a syntax error).
 */
const loadNeonConfig = async (
	cwd: string,
	contextFile: string | undefined,
): Promise<LoadedConfig | null> => {
	try {
		const { config, resolvedPath } = await loadProjectConfig({
			cwd,
			...(contextFile ? { contextFile } : {}),
		});
		return {
			config,
			configDir: dirname(resolvedPath),
			configPath: resolvedPath,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/Could not find a Neon config file/i.test(message)) {
			return null;
		}
		throw err;
	}
};
