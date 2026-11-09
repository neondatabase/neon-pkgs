import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseExportedSchema } from "../schema/parse.js";
import { field, schema, table, v } from "../test-fixtures.js";
import { importConvexExport } from "./import.js";

let dir: string;
let zipPath: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "c2pg-import-"));
	zipPath = join(dir, "snapshot.zip");
	writeFileSync(
		zipPath,
		zipSync({
			"other/documents.jsonl": strToU8(
				`{"_id":"o1","_creationTime":1}\n`,
			),
		}),
	);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("importConvexExport", () => {
	test("refuses an export with no documents for a schema table, before connecting", async () => {
		await expect(
			importConvexExport({
				schema: parseExportedSchema(
					schema([
						table({
							name: "items",
							fields: { a: field(v.string()) },
						}),
					]),
				),
				source: zipPath,
				// Never dialed: the check runs before the connection opens.
				connectionString: "postgres://unused@127.0.0.1:1/none",
			}),
		).rejects.toThrow('schema table(s) "items"');
	});
});
