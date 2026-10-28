import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { withExtractedExport } from "./export-dir.js";

let work: string;

beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "c2pg-export-dir-"));
});

afterAll(() => {
	rmSync(work, { recursive: true, force: true });
});

function writeZip(name: string, entries: Record<string, string>): string {
	const path = join(work, name);
	const files = Object.fromEntries(
		Object.entries(entries).map(([entry, text]) => [entry, strToU8(text)]),
	);
	writeFileSync(path, zipSync(files));
	return path;
}

describe("withExtractedExport", () => {
	test("passes a directory through unchanged", async () => {
		const seen = await withExtractedExport(work, (dir) => dir);
		expect(seen).toBe(work);
	});

	test("extracts each table's documents.jsonl from a zip, and only those", async () => {
		const zip = writeZip("snapshot.zip", {
			"README.md": "export",
			"_tables/documents.jsonl": '{"name":"messages"}\n',
			"_storage/documents.jsonl": '{"_id":"s1"}\n',
			"_storage/s1": "binary blob",
			"messages/documents.jsonl": '{"_id":"m1"}\n',
			"messages/generated_schema.jsonl": '"any"\n',
		});
		const listing = await withExtractedExport(zip, (dir) => ({
			top: readdirSync(dir).sort(),
			messages: readdirSync(join(dir, "messages")),
			body: readFileSync(
				join(dir, "messages", "documents.jsonl"),
				"utf8",
			),
		}));
		expect(listing).toEqual({
			top: ["messages"],
			messages: ["documents.jsonl"],
			body: '{"_id":"m1"}\n',
		});
	});

	test("removes the temporary directory afterwards, even when fn throws", async () => {
		const zip = writeZip("cleanup.zip", {
			"messages/documents.jsonl": "{}\n",
		});
		let extracted = "";
		await expect(
			withExtractedExport(zip, (dir) => {
				extracted = dir;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(extracted).not.toBe("");
		expect(existsSync(extracted)).toBe(false);
	});

	test("refuses an entry that would land outside the temporary directory", async () => {
		const zip = writeZip("slip.zip", { "../documents.jsonl": "{}\n" });
		await expect(
			withExtractedExport(zip, () => "unreached"),
		).rejects.toThrow("points outside the export");
	});

	test("rejects a file that is not a zip", async () => {
		const path = join(work, "snapshot.tar");
		writeFileSync(path, "");
		await expect(
			withExtractedExport(path, () => "unreached"),
		).rejects.toThrow("Unsupported export");
	});

	test("reports a missing path", async () => {
		await expect(
			withExtractedExport(join(work, "missing.zip"), () => "unreached"),
		).rejects.toThrow("No export at");
	});
});
