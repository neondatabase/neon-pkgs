/**
 * Shared VSIX download utilities for extension installation.
 * Supports corporate proxy via NEON_VSX_GALLERY_URL env var.
 */
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

export const NEON_EXTENSION_ID = "databricks.neon-local-connect";
const OPEN_VSX_API = "https://open-vsx.org/api";

/**
 * Downloads a .vsix file for the Neon extension.
 *
 * Strategy:
 * 1. If NEON_VSX_GALLERY_URL is set, download from the corporate proxy gallery
 * 2. Otherwise, download from the public Open VSX API
 *
 * Returns the path to the temp .vsix file, or null on failure.
 */
export async function downloadVsix(): Promise<string | null> {
	// Runtime env var takes priority, then build-time baked value
	const { INTERNAL_VSX_GALLERY } = await import("./build-config.js");
	const proxyGallery =
		process.env.NEON_VSX_GALLERY_URL || INTERNAL_VSX_GALLERY || "";
	if (proxyGallery) {
		return downloadFromGallery(proxyGallery);
	}
	return downloadFromOpenVsx();
}

/**
 * Downloads from a VS Code marketplace-compatible gallery API (corporate proxy).
 * Uses the VS Code extensionquery POST API to find the VSIX download URL.
 */
async function downloadFromGallery(galleryUrl: string): Promise<string | null> {
	const [publisher, name] = NEON_EXTENSION_ID.split(".");
	const baseUrl = galleryUrl.replace(/\/+$/, "");
	const queryUrl = `${baseUrl}/extensionquery`;

	try {
		// Query the marketplace API for the extension
		const queryRes = await fetch(queryUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json;api-version=6.1-preview.1",
			},
			body: JSON.stringify({
				filters: [
					{
						criteria: [
							{ filterType: 7, value: `${publisher}.${name}` },
						],
					},
				],
				flags: 914,
			}),
			signal: AbortSignal.timeout(15000),
		});

		if (!queryRes.ok) return null;

		const data = (await queryRes.json()) as {
			results?: {
				extensions?: {
					versions?: {
						files?: { assetType: string; source: string }[];
					}[];
				}[];
			}[];
		};

		// Find the VSIX download URL from the response
		const extension = data.results?.[0]?.extensions?.[0];
		const latestVersion = extension?.versions?.[0];
		const vsixFile = latestVersion?.files?.find(
			(f) =>
				f.assetType === "Microsoft.VisualStudio.Services.VSIXPackage",
		);

		if (!vsixFile?.source) return null;

		// Download the VSIX
		const vsixRes = await fetch(vsixFile.source, {
			signal: AbortSignal.timeout(30000),
			redirect: "follow",
		});
		if (!vsixRes.ok || !vsixRes.body) return null;

		const tmpPath = join(tmpdir(), `${NEON_EXTENSION_ID}-proxy.vsix`);
		const fileStream = createWriteStream(tmpPath);
		await pipeline(
			vsixRes.body as unknown as NodeJS.ReadableStream,
			fileStream,
		);
		return tmpPath;
	} catch {
		return null;
	}
}

/**
 * Downloads from the public Open VSX API.
 */
async function downloadFromOpenVsx(): Promise<string | null> {
	const [publisher, name] = NEON_EXTENSION_ID.split(".");
	const metaUrl = `${OPEN_VSX_API}/${publisher}/${name}/latest`;

	try {
		const metaRes = await fetch(metaUrl, {
			signal: AbortSignal.timeout(10000),
		});
		if (!metaRes.ok) return null;

		const meta = (await metaRes.json()) as {
			files?: { download?: string };
			version?: string;
		};
		const downloadUrl = meta.files?.download;
		if (!downloadUrl) return null;

		const vsixRes = await fetch(downloadUrl, {
			signal: AbortSignal.timeout(30000),
		});
		if (!vsixRes.ok || !vsixRes.body) return null;

		const tmpPath = join(
			tmpdir(),
			`${NEON_EXTENSION_ID}-${meta.version ?? "latest"}.vsix`,
		);
		const fileStream = createWriteStream(tmpPath);
		await pipeline(
			vsixRes.body as unknown as NodeJS.ReadableStream,
			fileStream,
		);
		return tmpPath;
	} catch {
		return null;
	}
}
