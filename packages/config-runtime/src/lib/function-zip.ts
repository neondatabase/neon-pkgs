import { ErrorCode, PlatformError } from "@neon/config";
import { assertZipWithinLimits, enforceLimits } from "./native-packages.js";

/**
 * Zip a file map with the compression the Functions deploy endpoint expects.
 * No size check — the esbuild path without staged native files preserves the
 * pre-existing unlimited archive. {@link zipFunctionBundle} enforces limits.
 */
export async function zipEntries(
	entries: Record<string, Uint8Array>,
): Promise<Uint8Array> {
	const { zipSync } = await loadFflate();
	return zipSync(entries, { level: 6 });
}

/**
 * Zip a file map into the archive the deploy endpoint expects, enforcing the
 * build service's size limits. The path every non-esbuild bundler funnels through.
 */
export async function zipFunctionBundle(
	slug: string,
	entries: Record<string, Uint8Array>,
): Promise<Uint8Array> {
	enforceLimits(slug, entries);
	const zip = await zipEntries(entries);
	assertZipWithinLimits(slug, zip, entries);
	return zip;
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
