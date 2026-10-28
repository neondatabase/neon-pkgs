import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";

/** The only entries the generators read: `<table>/documents.jsonl`. */
const DOCUMENTS_ENTRY = /^[^/_][^/]*\/documents\.jsonl$/;

/**
 * Run `fn` against a `convex export` snapshot as an extracted directory. A
 * directory passes through as is. A `.zip` (what `npx convex export` writes) is
 * extracted into a temporary directory that is removed once `fn` settles.
 *
 * `generateSeedSql` and `generateDataSql` read a directory and stay synchronous,
 * so the CLI owns the zip handling for `seed`. Only `<table>/documents.jsonl`
 * entries are extracted, which skips any file-storage blobs in the snapshot.
 */
export async function withExtractedExport<T>(
	source: string,
	fn: (dir: string) => T | Promise<T>,
): Promise<T> {
	const info = statSync(source, { throwIfNoEntry: false });
	if (info === undefined) {
		throw new Error(`No export at ${source}.`);
	}
	if (info.isDirectory()) {
		return await fn(source);
	}
	if (!source.toLowerCase().endsWith(".zip")) {
		throw new Error(
			`Unsupported export "${source}": pass the .zip from \`npx convex export\` or an extracted directory.`,
		);
	}

	const dir = mkdtempSync(join(tmpdir(), "convex-to-postgres-"));
	try {
		extractDocuments(readFileSync(source), dir);
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function extractDocuments(zip: Uint8Array, dir: string): void {
	const entries = unzipSync(zip, {
		filter: (file) => DOCUMENTS_ENTRY.test(file.name),
	});
	for (const [name, data] of Object.entries(entries)) {
		const target = resolve(dir, name);
		// A `..` table directory would write outside the temporary directory.
		if (!target.startsWith(dir + sep)) {
			throw new Error(
				`Refusing to extract "${name}": it points outside the export.`,
			);
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, data);
	}
}
