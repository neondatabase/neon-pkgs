import { createReadStream, existsSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { unzipSync } from "fflate";

/** A read view over a `convex export` snapshot (an extracted directory or a `.zip`). */
export interface ExportSource {
	/** User table names present in the export (excludes `_`-prefixed system dirs). */
	listTables(): string[];
	/** Whether the export carries a `documents.jsonl` for the given table. */
	hasTable(table: string): boolean;
	/** Async-iterate the non-empty raw JSONL lines for a table, in file order. */
	readLines(table: string): AsyncIterable<string>;
}

const DOCUMENTS_FILE = "documents.jsonl";

/**
 * Open a `convex export` snapshot. `source` is either an extracted directory or
 * a `.zip` produced by `npx convex export`. The zip is read fully into memory
 * (exports are modest); directories are streamed line by line.
 */
export async function openExportSource(source: string): Promise<ExportSource> {
	const info = await stat(source);
	if (info.isDirectory()) {
		return new DirectoryExportSource(source);
	}
	if (source.toLowerCase().endsWith(".zip")) {
		const buffer = await readFile(source);
		return new ZipExportSource(buffer);
	}
	throw new Error(
		`Unsupported export source "${source}": pass an extracted directory or a .zip file.`,
	);
}

class DirectoryExportSource implements ExportSource {
	constructor(private readonly root: string) {}

	listTables(): string[] {
		return readdirSync(this.root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => !name.startsWith("_"))
			.sort();
	}

	hasTable(table: string): boolean {
		return existsSync(join(this.root, table, DOCUMENTS_FILE));
	}

	async *readLines(table: string): AsyncIterable<string> {
		const path = join(this.root, table, DOCUMENTS_FILE);
		const rl = createInterface({
			input: createReadStream(path, { encoding: "utf8" }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		for await (const line of rl) {
			if (line.trim().length > 0) yield line;
		}
	}
}

class ZipExportSource implements ExportSource {
	private readonly entries: Record<string, Uint8Array>;
	private readonly decoder = new TextDecoder();

	constructor(buffer: Uint8Array) {
		this.entries = unzipSync(buffer);
	}

	listTables(): string[] {
		const names = new Set<string>();
		for (const path of Object.keys(this.entries)) {
			const slash = path.indexOf("/");
			if (slash <= 0) continue;
			const dir = path.slice(0, slash);
			if (!dir.startsWith("_") && path.endsWith(DOCUMENTS_FILE)) {
				names.add(dir);
			}
		}
		return [...names].sort();
	}

	hasTable(table: string): boolean {
		return `${table}/${DOCUMENTS_FILE}` in this.entries;
	}

	async *readLines(table: string): AsyncIterable<string> {
		const entry = this.entries[`${table}/${DOCUMENTS_FILE}`];
		if (entry === undefined) return;
		const text = this.decoder.decode(entry);
		for (const line of text.split(/\r?\n/)) {
			if (line.trim().length > 0) yield line;
		}
	}
}
