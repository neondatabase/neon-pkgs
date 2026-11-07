import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { field, schema, table, v } from "../test-fixtures.js";
import { loadConvexAuthTableNames, loadConvexSchema } from "./load.js";

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

describe("loadConvexAuthTableNames", () => {
	let apps: string;

	/** An app with a `convex/schema.ts` and, optionally, a stub package. */
	function app(name: string, serverJs?: string): string {
		const root = join(apps, name);
		mkdirSync(join(root, "convex"), { recursive: true });
		const schemaPath = join(root, "convex", "schema.ts");
		writeFileSync(schemaPath, "export default {};\n");
		if (serverJs !== undefined) {
			const pkg = join(root, "node_modules", "@convex-dev", "auth");
			mkdirSync(join(pkg, "server"), { recursive: true });
			writeFileSync(
				join(pkg, "package.json"),
				JSON.stringify({
					name: "@convex-dev/auth",
					type: "module",
					exports: { "./server": { import: "./server/index.js" } },
				}),
			);
			writeFileSync(join(pkg, "server", "index.js"), serverJs);
		}
		return schemaPath;
	}

	beforeAll(() => {
		apps = mkdtempSync(join(tmpdir(), "c2pg-auth-"));
	});

	afterAll(() => {
		rmSync(apps, { recursive: true, force: true });
	});

	test("returns the keys of the installed package's authTables", async () => {
		const schemaPath = app(
			"installed",
			"export const authTables = { users: {}, authSessions: {}, authFuture: {} };\nexport function convexAuth() {}\n",
		);
		expect(await loadConvexAuthTableNames(schemaPath)).toEqual([
			"users",
			"authSessions",
			"authFuture",
		]);
	});

	test("resolves from the schema file, not the cwd", async () => {
		const schemaPath = app(
			"from-schema",
			"export const authTables = { users: {}, authAccounts: {} };\n",
		);
		const cwd = process.cwd();
		process.chdir(tmpdir());
		try {
			expect(await loadConvexAuthTableNames(schemaPath)).toEqual([
				"users",
				"authAccounts",
			]);
		} finally {
			process.chdir(cwd);
		}
	});

	test("undefined when the package isn't installed", async () => {
		expect(await loadConvexAuthTableNames(app("missing"))).toBeUndefined();
	});

	test("undefined when the package has no authTables", async () => {
		const schemaPath = app(
			"no-tables",
			"export function convexAuth() {}\n",
		);
		expect(await loadConvexAuthTableNames(schemaPath)).toBeUndefined();
	});
});
