import { basename, dirname } from "node:path";
import {
	ErrorCode,
	type FunctionBundle,
	PlatformError,
	packagesToStage,
	type ResolvedFunctionConfig,
} from "@neon/config";
import { bundleAsIs, resolveEsbuildEntry } from "./function-source.js";
import { zipEntries, zipFunctionBundle } from "./function-zip.js";
import {
	describeNativeFinding,
	findUndeclaredNativePackages,
} from "./native-detect.js";
import {
	type NativeTraceDeps,
	traceNativePackages,
} from "./native-packages.js";

/**
 * Builds the deployable ZIP for a single function. The default
 * ({@link buildFunctionBundle}) honors `fn.bundler`. `pushConfig` / `apply`
 * accept a custom bundler so a consumer that cannot load esbuild (e.g. a
 * single-file CLI) can supply its own.
 *
 * This deploy-level callback returns finished archive bytes; `@neon/config`'s
 * per-function `FunctionBundler` returns a {@link FunctionBundle} file map.
 */
export type FunctionBundler = (
	fn: ResolvedFunctionConfig,
) => Promise<Uint8Array>;

/**
 * Prepended to the ESM bundle. Bundled dependencies are frequently CommonJS, but an ESM
 * output (`format: "esm"`) has no `require` / `__filename` / `__dirname` in scope — so any
 * bundled CJS code that calls `require(...)` would fail at load with
 * `Dynamic require of "x" is not supported`. Re-create those globals via `createRequire`
 * so CJS and ESM dependencies coexist in the single `index.mjs`.
 */
export const ESM_CJS_INTEROP_BANNER =
	"import{createRequire as ___cr}from'module';import{fileURLToPath as ___f}from'url';import{dirname as ___d}from'path';const require=___cr(import.meta.url);const __filename=___f(import.meta.url);const __dirname=___d(__filename);";

type FunctionBundleOptions = {
	nativeDeps?: Partial<NativeTraceDeps>;
	/**
	 * Where advisory findings go — the undeclared-native-dependency report, and a package
	 * whose version could not be pinned.
	 *
	 * Defaults to discarding them, because a library has no business writing to the
	 * console. Pass a handler: these are the only signal that a function will fail at
	 * invoke, and the CLI wires this to its logger for exactly that reason.
	 */
	onWarning?: (message: string) => void;
};

/**
 * Build the deployable ZIP for a function, honoring `fn.bundler`.
 *
 * `"esbuild"` (the default) discovers an entry (`index.ts`, then `index.js`, then
 * `index.mjs`) and bundles it. `"none"` zips `source` as-is. An inline function returns a
 * file map that is zipped.
 *
 * The packaged CLI never calls this. It injects its own bundler and imports
 * {@link bundleAsIs} from `function-source.ts`, which does not load esbuild.
 */
export async function buildFunctionBundle(
	fn: ResolvedFunctionConfig,
	options: FunctionBundleOptions = {},
): Promise<Uint8Array> {
	const { bundler } = fn;
	if (bundler === undefined || bundler === "esbuild") {
		return bundleWithEsbuild(fn, options);
	}
	const bundle =
		bundler === "none" ? await bundleAsIs(fn) : await bundler(fn);
	return zipFunctionBundle(fn.slug, bundle);
}

/**
 * Mirrors: `esbuild <source> --bundle --outfile=index.mjs --minify --format=esm
 * --platform=node --banner:js=<createRequire shim>`, then zips the emitted files into the
 * archive the Functions deploy endpoint expects. Dependencies are bundled into the entry
 * (Node built-ins stay external); see {@link ESM_CJS_INTEROP_BANNER} for why the banner.
 *
 * No source map is emitted: the Functions runtime does not run Node with source-map support,
 * so an uploaded `index.mjs.map` is never consumed (a thrown error's stack still points into
 * the minified bundle). Generating it only inflated the deployed archive, so it is omitted.
 */
const bundleWithEsbuild = async (
	fn: ResolvedFunctionConfig,
	options: FunctionBundleOptions = {},
): Promise<Uint8Array> => {
	const entry = await resolveEsbuildEntry(fn.source);
	const esbuild = await loadEsbuild();
	const externalPackages = fn.externalPackages ?? [];
	const staged = packagesToStage(externalPackages);
	const onWarning = options.onWarning ?? (() => {});
	const projectDir = dirname(entry);

	let result: Awaited<ReturnType<typeof esbuild.build>>;
	try {
		result = await esbuild.build({
			entryPoints: [entry],
			bundle: true,
			write: false,
			// Emit `index.mjs`: the Functions runtime imports the archive's entry by the
			// conventional `index.{js,mjs}` name, and `.mjs` makes Node load the ESM output
			// directly. (With `write: false` and no outfile, esbuild would label the buffer
			// `<stdout>`.) No `sourcemap` — see the doc comment above for why.
			outfile: "index.mjs",
			minify: true,
			format: "esm",
			platform: "node",
			// Bundle dependencies into the entry so the deployed archive is self-contained
			// (the Functions runtime has no node_modules). Node built-ins stay external on
			// `platform: "node"`. The banner re-creates require/__filename/__dirname so
			// bundled CommonJS deps work inside the ESM output.
			banner: { js: ESM_CJS_INTEROP_BANNER },
			// Packages the policy declared unbundleable. Their imports survive into the
			// bundle instead of being followed; whether they then resolve at runtime depends
			// on `includeFiles`, which is acted on below. Both modes are external here.
			external: externalPackages.map((pkg) => pkg.name),
			// Reveals which packages were bundled in, so an undeclared native dependency can
			// be reported. Costs nothing here — esbuild is already running.
			metafile: true,
			logLevel: "silent",
		});
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			[
				`Failed to bundle function "${fn.slug}" from ${entry}.`,
				detail,
			].join(" "),
			{ cause },
		);
	}

	const entries: Record<string, Uint8Array> = {};
	// `write: false` guarantees `outputFiles`, but the type is optional — guard for safety.
	for (const file of result.outputFiles ?? []) {
		// esbuild returns absolute output paths; archive them under their basename
		// (`index.mjs`) so the bundle layout is stable regardless of cwd.
		entries[basename(file.path)] = file.contents;
	}

	// Only reachable on a successful build, which is the point: `sharp` and its kind bundle
	// cleanly and fail at invoke, so this is exactly the case nothing else catches. A build
	// that throws has already failed loudly with esbuild's own diagnostic.
	for (const finding of findUndeclaredNativePackages({
		metafile: result.metafile,
		declared: externalPackages.map((pkg) => pkg.name),
		projectDir,
	})) {
		onWarning(describeNativeFinding(fn.slug, finding));
	}

	// The pre-existing path, byte for byte: no install, no trace, no size check, and an
	// archive of exactly the esbuild output. A policy that declares nothing to stage — or
	// sets `includeFiles: false` on everything — deploys the archive it always did.
	if (staged.length === 0) return zipEntries(entries);

	const traced = await traceNativePackages({
		slug: fn.slug,
		packages: staged,
		// The user's project, located from their entry — where their resolved versions are
		// read from. Only versions: the files themselves come from the staging install.
		projectDir,
		...(options.nativeDeps ? { deps: options.nativeDeps } : {}),
	});
	for (const warning of traced.warnings) onWarning(warning);
	// Keys carry their `node_modules/...` path, so the archive reproduces the tree layout a
	// `.node` addon needs to find its sibling libraries. Do not flatten these.
	Object.assign(entries, traced.entries);

	// Re-checked against the final archive: the staged files were measured without the
	// bundle, so the entry count and uncompressed total are only complete now.
	return zipFunctionBundle(fn.slug, entries);
};

type EsbuildModule = {
	build: (opts: Record<string, unknown>) => Promise<{
		outputFiles?: readonly { path: string; contents: Uint8Array }[];
		metafile?: { inputs?: Record<string, unknown> };
	}>;
};

const loadEsbuild = async (): Promise<EsbuildModule> => {
	// Computed so rollup and pkg cannot see the module name and snapshot the native binary.
	const name = ["es", "build"].join("");
	try {
		return (await import(name)) as EsbuildModule;
	} catch (cause) {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			[
				"Deploying Neon Functions requires `esbuild`, which could not be loaded.",
				"It is a dependency of @neon/config-runtime — reinstall your dependencies (`pnpm install` / `npm install`).",
			].join(" "),
			{ cause },
		);
	}
};
