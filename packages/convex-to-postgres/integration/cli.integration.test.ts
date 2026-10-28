import { spawn } from "node:child_process";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { countJsonlLines, FIXTURES, freshSchemaClient } from "./helpers.js";

/** The built `bin` entry; `pnpm test:integration` builds before running. */
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const SAMPLE = join(FIXTURES, "export-sample");
const TUTORIAL = join(FIXTURES, "tutorial-export");

const SAMPLE_COUNTS = {
	authors: countJsonlLines(join(SAMPLE, "authors", "documents.jsonl")),
	posts: countJsonlLines(join(SAMPLE, "posts", "documents.jsonl")),
	misc: countJsonlLines(join(SAMPLE, "misc", "documents.jsonl")),
};

function runCli(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI, ...args], {
			env: { ...process.env, DATABASE_URL: "", ...env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

/**
 * A connection string for the shared container whose sessions resolve
 * unqualified names in `schema`, so the spawned CLI writes into the test's own
 * namespace exactly as `freshSchemaClient`'s client does.
 */
function urlForSchema(schema: string): string {
	const url = new URL(inject("pgConnectionUri"));
	url.searchParams.set("options", `-c search_path=${schema}`);
	return url.toString();
}

async function count(
	client: { query: (t: string) => Promise<{ rows: unknown[] }> },
	table: string,
): Promise<number> {
	const res = await client.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
	return (res.rows[0] as { n: number }).n;
}

/**
 * Suite D: the published `bin`, spawned as `npx @neon/convex-to-postgres`
 * would run it, against the shared Postgres container.
 */
describe("Suite D: the built CLI", () => {
	let work: string;

	beforeAll(() => {
		work = mkdtempSync(join(tmpdir(), "c2pg-cli-int-"));
	});

	afterAll(() => {
		rmSync(work, { recursive: true, force: true });
	});

	test("import --apply-schema loads a .zip snapshot via DATABASE_URL", async () => {
		const ctx = await freshSchemaClient("cli_import");
		try {
			const result = await runCli(
				[
					"import",
					"--schema",
					join(SAMPLE, "convex", "schema.ts"),
					"--export",
					join(SAMPLE, "snapshot.zip"),
					"--apply-schema",
				],
				{ DATABASE_URL: urlForSchema(ctx.schema) },
			);
			const rows = Object.values(SAMPLE_COUNTS).reduce(
				(a, b) => a + b,
				0,
			);
			expect(result.stderr).toContain(
				`Imported ${rows} row(s) into 3 table(s).`,
			);
			expect(result.code).toBe(0);
			expect(result.stdout).toBe("");
			for (const [table, n] of Object.entries(SAMPLE_COUNTS)) {
				expect(await count(ctx.client, table)).toBe(n);
			}
		} finally {
			await ctx.cleanup();
		}
	});

	test("a failed import exits 1 and leaves no partial load", async () => {
		const ctx = await freshSchemaClient("cli_import_fail");
		try {
			// Without --apply-schema the target tables do not exist, so the
			// transform fails inside the transaction and everything rolls back.
			const result = await runCli([
				"import",
				"--schema",
				join(SAMPLE, "convex", "schema.ts"),
				"--export",
				SAMPLE,
				"--database-url",
				urlForSchema(ctx.schema),
			]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("convex-to-postgres: ");
			const left = await ctx.client.query(
				"SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = $1",
				[ctx.schema],
			);
			expect((left.rows[0] as { n: number }).n).toBe(0);
		} finally {
			await ctx.cleanup();
		}
	});

	test("a dangling reference fails the import with Postgres's detail line", async () => {
		// Convex does not enforce references; point one post at a deleted author.
		const dangling = join(work, "dangling");
		cpSync(SAMPLE, dangling, { recursive: true });
		const posts = join(dangling, "posts", "documents.jsonl");
		writeFileSync(
			posts,
			readFileSync(posts, "utf8").replace(
				/"authorId":"[^"]+"/,
				'"authorId":"deleted-author"',
			),
		);

		const ctx = await freshSchemaClient("cli_dangling");
		try {
			const result = await runCli([
				"import",
				"--schema",
				join(SAMPLE, "convex", "schema.ts"),
				"--export",
				dangling,
				"--apply-schema",
				"--database-url",
				urlForSchema(ctx.schema),
			]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("violates foreign key constraint");
			expect(result.stderr).toContain("  detail: Key (author_id)=(");
		} finally {
			await ctx.cleanup();
		}
	});

	test("seed --split files run in order, including a hand-edited rename", async () => {
		const dir = join(work, "tutorial");
		const split = await runCli([
			"seed",
			"--schema",
			join(TUTORIAL, "convex", "schema.ts"),
			"--export",
			join(TUTORIAL, "snapshot.zip"),
			"--split",
			dir,
		]);
		expect(split.code).toBe(0);
		expect(split.stdout).toBe("");

		// The flow the split exists for: rename a column in the schema, then make
		// the one matching edit to the transform's column list.
		const schemaFile = join(dir, "01-schema.sql");
		const transformFile = join(dir, "03-transform.sql");
		const schemaSql = readFileSync(schemaFile, "utf8");
		const transformSql = readFileSync(transformFile, "utf8");
		expect(schemaSql).toContain("    author text NOT NULL\n");
		expect(transformSql).toContain(
			"INSERT INTO messages (id, created_at, body, author)",
		);
		writeFileSync(
			schemaFile,
			schemaSql.replace(
				"    author text NOT NULL\n",
				"    author_name text NOT NULL\n",
			),
		);
		writeFileSync(
			transformFile,
			transformSql.replace(
				"INSERT INTO messages (id, created_at, body, author)",
				"INSERT INTO messages (id, created_at, body, author_name)",
			),
		);

		const ctx = await freshSchemaClient("cli_split");
		try {
			// Each file is its own session-level script, like `psql -f`; the
			// staging tables from 02 persist until 03 drops them.
			for (const file of [
				"01-schema.sql",
				"02-load.sql",
				"03-transform.sql",
			]) {
				await ctx.client.query(readFileSync(join(dir, file), "utf8"));
			}
			expect(await count(ctx.client, "messages")).toBe(
				countJsonlLines(join(TUTORIAL, "messages", "documents.jsonl")),
			);
			const first = await ctx.client.query(
				"SELECT author_name FROM messages ORDER BY created_at LIMIT 1",
			);
			expect((first.rows[0] as { author_name: string }).author_name).toBe(
				"Ada",
			);
			const staging = await ctx.client.query(
				"SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE '\\_convex\\_%'",
				[ctx.schema],
			);
			expect((staging.rows[0] as { n: number }).n).toBe(0);
		} finally {
			await ctx.cleanup();
		}
	});
});
