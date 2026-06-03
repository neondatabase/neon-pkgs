import type { ResolvedFunctionConfig } from "./types.js";

/**
 * Build the deployable bundle (ZIP archive of bundled source) for a function.
 *
 * This is the **imperative shell** step of function deploys: it reads `fn.source` from the
 * filesystem, bundles it (esbuild) and ZIPs it for the multipart deploy endpoint. Keeping
 * it isolated here (rather than inside the pure diff/resolve layer) preserves the
 * "functional core, imperative shell" boundary the rest of the config package follows.
 *
 * TODO(neon-deploy): implement real bundling. Decide and wire up the toolchain:
 *   - esbuild to bundle `fn.source` (resolved relative to the loaded `neon.ts` path) into a
 *     single ESM entry, externalizing the Node built-ins the runtime provides.
 *   - a ZIP library (e.g. fflate) to archive the build output into the bytes the Functions
 *     deploy endpoint expects (`multipart/form-data` `file`).
 *   - whether these become direct deps of `@neondatabase/config`, lazy dynamic imports, or
 *     a peer dependency the consumer installs. (See the open dependency decision.)
 *
 * Until then this returns an empty bundle so the create/deploy plan steps, the in-memory
 * fake, and the real API wiring are all exercised end to end without shipping real code.
 */
export async function buildFunctionBundle(
	_fn: ResolvedFunctionConfig,
): Promise<Uint8Array> {
	// Noop placeholder — see TODO above.
	return new Uint8Array(0);
}
