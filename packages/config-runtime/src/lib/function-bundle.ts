import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
	ErrorCode,
	type FunctionBundle,
	PlatformError,
	packagesToStage,
	type ResolvedFunctionConfig,
} from "@neon/config";
import {
	describeNativeFinding,
	findUndeclaredNativePackages,
} from "./native-detect.js";
import {
	assertZipWithinLimits,
	enforceLimits,
	type NativeTraceDeps,
	traceNativePackages,
} from "./native-packages.js";

/**
 * Builds the deployable ZIP bundle for a single function. The default
 * implementation ({@link buildFunctionBundle}) shells out to esbuild, but
 * `pushConfig` / `apply` accept a custom bundler so a consumer that can't ship
 * esbuild's native binary (e.g. a single-file CLI) can supply its own — a WASM
 * build, an esbuild binary on PATH, etc. — without this package dragging esbuild
 * into their bundle.
 *
 * Distinct from `@neon/config`'s `FunctionBundler`: that one is the per-function
 * `neon.ts` `bundler` and returns a {@link FunctionBundle} (a file map); this one is
 * the deploy-side escape hatch and returns the finished archive bytes. The default
 * ({@link resolveFunctionArchive}) turns a config-level bundler's file map into these
 * bytes.
 */
export type FunctionBundler = (
	fn: ResolvedFunctionConfig,
) => Promise<Uint8Array>;

/**
 * The conventional entry filenames the Functions runtime imports from the archive root.
 * A bundle that carries neither cannot be invoked, so every non-esbuild bundler's output
 * is checked for one before it is shipped.
 */
const ENTRY_FILENAMES = ["index.mjs", "index.js"];

/**
 * Prepended to the ESM bundle. Bundled dependencies are frequently CommonJS, but an ESM
 * output (`format: "esm"`) has no `require` / `__filename` / `__dirname` in scope — so any
 * bundled CJS code that calls `require(...)` would fail at load with
 * `Dynamic require of "x" is not supported`. Re-create those globals via `createRequire`
 * so CJS and ESM dependencies coexist in the single `index.mjs`.
 */
export const ESM_CJS_INTEROP_BANNER =
	"import{createRequire as ___cr}from'module';import{fileURLToPath as ___f}from'url';import{dirname as ___d}from'path';const require=___cr(import.meta.url);const __filename=___f(import.meta.url);const __dirname=___d(__filename);";

/**
 * Build the deployable archive for a function, honouring its `neon.ts` `bundler`. The
 * top-level entry point the deploy path calls: it dispatches on {@link ResolvedFunctionConfig.bundler}
 * and always returns the finished archive bytes.
 *
 * - `"esbuild"` (default) — {@link buildFunctionBundle}, unchanged. Keeps its own archiving and
 *   limit handling, so a plain bundle deploys byte-for-byte as it did before this dispatch existed.
 * - `"zip-directory"` — {@link bundleDirectory} → {@link zipFunctionBundle}.
 * - an inline function — the user's bundler produces a {@link FunctionBundle}, which is then
 *   zipped and size-checked here. The bundler decides the contents; the platform's archive
 *   limits still apply.
 */
export async function resolveFunctionArchive(
	fn: ResolvedFunctionConfig,
	options: {
		nativeDeps?: Partial<NativeTraceDeps>;
		onWarning?: (message: string) => void;
	} = {},
): Promise<Uint8Array> {
	const { bundler } = fn;
	if (bundler === undefined || bundler === "esbuild") {
		return buildFunctionBundle(fn, options);
	}
	const bundle =
		bundler === "zip-directory"
			? await bundleDirectory(fn)
			: await bundler(fn);
	return zipFunctionBundle(fn.slug, bundle);
}

/**
 * Build the deployable bundle (a ZIP archive of the esbuild-bundled source) for a function.
 *
 * This is the **imperative shell** step of function deploys, and the reason it lives in
 * `@neon/config-runtime` rather than `@neon/config`: it pulls in `esbuild`
 * (a native binary) and `fflate`. Keeping it out of `@neon/config` means a `neon.ts`
 * that only imports `defineConfig` never drags esbuild into the user's dependency tree or
 * bundle. Deploy-side consumers (the neonctl CLI, CI) import this package and get esbuild as
 * a normal, auto-installed dependency.
 *
 * esbuild and fflate are loaded with a dynamic `import()` (not a static top-level import) so
 * that nothing in this package's static graph names esbuild until a deploy actually runs —
 * a second layer of protection on top of the package split.
 *
 * Mirrors: `esbuild <source> --bundle --outfile=index.mjs --minify --format=esm
 * --platform=node --banner:js=<createRequire shim>`, then zips the emitted files into the
 * archive the Functions deploy endpoint expects. Dependencies are bundled into the entry
 * (Node built-ins stay external); see {@link ESM_CJS_INTEROP_BANNER} for why the banner.
 *
 * No source map is emitted: the Functions runtime does not run Node with source-map support,
 * so an uploaded `index.mjs.map` is never consumed (a thrown error's stack still points into
 * the minified bundle). Generating it only inflated the deployed archive, so it is omitted.
 */
export async function buildFunctionBundle(
	fn: ResolvedFunctionConfig,
	options: {
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
	} = {},
): Promise<Uint8Array> {
	const esbuild = await loadEsbuild();
	const externalPackages = fn.externalPackages ?? [];
	const staged = packagesToStage(externalPackages);
	const onWarning = options.onWarning ?? (() => {});

	let result: Awaited<ReturnType<typeof esbuild.build>>;
	try {
		result = await esbuild.build({
			entryPoints: [fn.source],
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
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			[
				`Failed to bundle function "${fn.slug}" from ${fn.source}.`,
				(cause as Error)?.message ?? String(cause),
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
		projectDir: dirname(fn.source),
	})) {
		onWarning(describeNativeFinding(fn.slug, finding));
	}

	// The pre-existing path, byte for byte: no install, no trace, no size check, and an
	// archive of exactly the esbuild output. A policy that declares nothing to stage — or
	// sets `includeFiles: false` on everything — deploys the archive it always did.
	if (staged.length === 0) return zipBundle(entries);

	const traced = await traceNativePackages({
		slug: fn.slug,
		packages: staged,
		// The user's project, located from their entry — where their resolved versions are
		// read from. Only versions: the files themselves come from the staging install.
		projectDir: dirname(fn.source),
		...(options.nativeDeps ? { deps: options.nativeDeps } : {}),
	});
	for (const warning of traced.warnings) onWarning(warning);
	// Keys carry their `node_modules/...` path, so the archive reproduces the tree layout a
	// `.node` addon needs to find its sibling libraries. Do not flatten these.
	Object.assign(entries, traced.entries);

	// Re-checked against the final archive: the staged files were measured without the
	// bundle, so the entry count and uncompressed total are only complete now.
	enforceLimits(fn.slug, entries);
	const zip = await zipBundle(entries);
	assertZipWithinLimits(fn.slug, zip, entries);
	return zip;
}

/**
 * Read a prebuilt output **directory** into a {@link FunctionBundle}, preserving its layout.
 * The `"zip-directory"` bundler: for a framework whose own build already emits a runnable
 * directory (e.g. `mastra build`), ship it as-is rather than bundling `source` a second time.
 *
 * Every file under `fn.source` is read recursively; keys are POSIX-style paths relative to
 * that directory, so a multi-file bundle whose chunks import each other by relative path —
 * or a nested asset directory the entry serves — arrives with its structure intact. The
 * directory must contain an entry module (`index.mjs` / `index.js`) at its root, or the
 * function could not be invoked; that is checked here rather than left to fail at deploy.
 */
export async function bundleDirectory(
	fn: ResolvedFunctionConfig,
): Promise<FunctionBundle> {
	let rootStat: Awaited<ReturnType<typeof stat>>;
	try {
		rootStat = await stat(fn.source);
	} catch (cause) {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			`Function "${fn.slug}" bundler is "zip-directory" but its source directory ${fn.source} does not exist.`,
			{ cause },
		);
	}
	if (!rootStat.isDirectory()) {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			`Function "${fn.slug}" bundler is "zip-directory" but its source ${fn.source} is a file, not a directory. ` +
				`Point source at the build output directory, or use the default "esbuild" bundler for a single entry module.`,
		);
	}

	const entries: FunctionBundle = {};
	await collectDirectory(fn.source, fn.source, entries);

	if (!ENTRY_FILENAMES.some((name) => name in entries)) {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			`Function "${fn.slug}" source directory ${fn.source} has no entry module at its root ` +
				`(expected one of: ${ENTRY_FILENAMES.join(", ")}). The Functions runtime imports the archive by that name.`,
		);
	}
	return entries;
}

/**
 * Recursively read `dir` into `entries`, keying each file by its POSIX path relative to
 * `root`. Empty directories are dropped: an archive carries files, and a bundle's layout is
 * defined by the paths of the files in it.
 */
async function collectDirectory(
	root: string,
	dir: string,
	entries: FunctionBundle,
): Promise<void> {
	const dirents = await readdir(dir, { withFileTypes: true });
	await Promise.all(
		dirents.map(async (dirent) => {
			const abs = join(dir, dirent.name);
			if (dirent.isDirectory()) {
				await collectDirectory(root, abs, entries);
				return;
			}
			// Symlinks are followed as their target: a bundle is a snapshot of bytes, and a
			// symlink into node_modules or up out of the tree would not resolve once unpacked.
			if (dirent.isSymbolicLink()) {
				const target = await stat(abs).catch(() => null);
				if (!target || target.isDirectory()) return;
			}
			const key = relative(root, abs).split(sep).join("/");
			entries[key] = new Uint8Array(await readFile(abs));
		}),
	);
}

/**
 * Zip a {@link FunctionBundle} into the archive the deploy endpoint expects, enforcing the
 * build service's size limits. The path every non-esbuild bundler funnels through — the
 * esbuild bundler keeps its own limit handling (it only checks when native files are staged,
 * preserving the pre-existing no-op path for a plain bundle).
 */
export async function zipFunctionBundle(
	slug: string,
	entries: FunctionBundle,
): Promise<Uint8Array> {
	enforceLimits(slug, entries);
	const zip = await zipBundle(entries);
	assertZipWithinLimits(slug, zip, entries);
	return zip;
}

async function zipBundle(
	entries: Record<string, Uint8Array>,
): Promise<Uint8Array> {
	const { zipSync } = await loadFflate();
	return zipSync(entries, { level: 6 });
}

async function loadEsbuild(): Promise<typeof import("esbuild")> {
	try {
		return await import("esbuild");
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
}

async function loadFflate(): Promise<typeof import("fflate")> {
	try {
		return await import("fflate");
	} catch (cause) {
		throw new PlatformError(
			ErrorCode.InvalidConfig,
			[
				"Deploying Neon Functions requires `fflate`, which could not be loaded.",
				"It is a dependency of @neon/config-runtime — reinstall your dependencies (`pnpm install` / `npm install`).",
			].join(" "),
			{ cause },
		);
	}
}
