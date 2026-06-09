import { basename } from "node:path";
import {
	ErrorCode,
	PlatformError,
	type ResolvedFunctionConfig,
} from "@neondatabase/config";

/**
 * Builds the deployable ZIP bundle for a single function. The default
 * implementation ({@link buildFunctionBundle}) shells out to esbuild, but
 * `pushConfig` / `apply` accept a custom bundler so a consumer that can't ship
 * esbuild's native binary (e.g. a single-file CLI) can supply its own — a WASM
 * build, an esbuild binary on PATH, etc. — without this package dragging esbuild
 * into their bundle.
 */
export type FunctionBundler = (
	fn: ResolvedFunctionConfig,
) => Promise<Uint8Array>;

/**
 * Build the deployable bundle (a ZIP archive of the esbuild-bundled source) for a function.
 *
 * This is the **imperative shell** step of function deploys, and the reason it lives in
 * `@neondatabase/config-runtime` rather than `@neondatabase/config`: it pulls in `esbuild`
 * (a native binary) and `fflate`. Keeping it out of `@neondatabase/config` means a `neon.ts`
 * that only imports `defineConfig` never drags esbuild into the user's dependency tree or
 * bundle. Deploy-side consumers (the neonctl CLI, CI) import this package and get esbuild as
 * a normal, auto-installed dependency.
 *
 * esbuild and fflate are loaded with a dynamic `import()` (not a static top-level import) so
 * that nothing in this package's static graph names esbuild until a deploy actually runs —
 * a second layer of protection on top of the package split.
 *
 * Mirrors: `esbuild <source> --bundle --outfile=index.mjs --sourcemap --minify`, then zips
 * the emitted files into the archive the Functions deploy endpoint expects.
 */
export async function buildFunctionBundle(
	fn: ResolvedFunctionConfig,
): Promise<Uint8Array> {
	const esbuild = await loadEsbuild();

	let result: Awaited<ReturnType<typeof esbuild.build>>;
	try {
		result = await esbuild.build({
			entryPoints: [fn.source],
			bundle: true,
			write: false,
			// Emit `index.mjs` / `index.mjs.map`: the Functions runtime imports the archive's
			// entry by the conventional `index.{js,mjs}` name, and `.mjs` makes Node load the
			// ESM output directly. (With `write: false` and no outfile, esbuild would label the
			// buffer `<stdout>`.)
			outfile: "index.mjs",
			sourcemap: true,
			minify: true,
			format: "esm",
			platform: "node",
			// The Functions runtime provides Node built-ins; don't try to bundle them.
			packages: "external",
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
		// (`index.mjs`, `index.mjs.map`) so the bundle layout is stable regardless of cwd.
		entries[basename(file.path)] = file.contents;
	}

	return zipBundle(entries);
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
				"It is a dependency of @neondatabase/config-runtime — reinstall your dependencies (`pnpm install` / `npm install`).",
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
				"It is a dependency of @neondatabase/config-runtime — reinstall your dependencies (`pnpm install` / `npm install`).",
			].join(" "),
			{ cause },
		);
	}
}
