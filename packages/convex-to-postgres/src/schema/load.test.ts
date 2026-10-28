import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { field, schema, table, v } from "../test-fixtures.js";
import { loadConvexSchema } from "./load.js";

const exported = schema([
	table({ name: "channels", fields: { name: field(v.string()) } }),
]);

let work: string;
let schemaTs: string;

beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "c2pg-load-"));
	schemaTs = join(work, "convex", "schema.ts");
	mkdirSync(join(work, "convex"), { recursive: true });
	// A stand-in: `loadConvexSchema` only needs a default export whose
	// `export()` returns the JSON string, so no `convex` import is needed.
	writeFileSync(
		schemaTs,
		`export default { export: () => ${JSON.stringify(JSON.stringify(exported))} };\n`,
	);
});

afterAll(() => {
	rmSync(work, { recursive: true, force: true });
});

describe("loadConvexSchema", () => {
	test("loads an absolute path", async () => {
		const loaded = await loadConvexSchema(schemaTs);
		expect(loaded.tables.map((t) => t.name)).toEqual(["channels"]);
	});

	// The README's call. It must point *down* from the cwd: a `../..` path that
	// climbs to the root resolves the same from anywhere and proves nothing.
	test("resolves a relative path against the cwd, not the schema file", async () => {
		const cwd = process.cwd();
		process.chdir(work);
		try {
			const loaded = await loadConvexSchema("./convex/schema.ts");
			expect(loaded.tables.map((t) => t.name)).toEqual(["channels"]);
		} finally {
			process.chdir(cwd);
		}
	});
});
