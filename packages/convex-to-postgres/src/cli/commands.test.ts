import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateDataSql, generateSeedSql } from "../data/seed.js";
import { generateStagingDropSql } from "../data/staging.js";
import { generateTransformSql } from "../data/transform.js";
import type { GenerateOptions } from "../options.js";
import { generateDdl, generateIndexDdl } from "../schema/generate-ddl.js";
import type { ExportedSchema } from "../schema/model.js";
import { parseExportedSchema } from "../schema/parse.js";
import { field, schema, table, v } from "../test-fixtures.js";
import { type CliIo, runCli, SPLIT_FILES } from "./commands.js";
import { COMMAND_HELP, TOP_HELP } from "./options.js";

const BIG_INT = "9007199254740993"; // 2^53 + 1, unrepresentable as a JS number

// `attachment` references a Convex system table, so its foreign key is dropped
// with a warning; the search index gives the schema a post-load index step.
const exported = schema([
	table({ name: "channels", fields: { name: field(v.string()) } }),
	table({
		name: "messages",
		fields: {
			channel: field(v.id("channels")),
			body: field(v.string()),
			big: field(v.int64()),
			attachment: field(v.id("_storage"), true),
		},
		searchIndexes: [
			{
				indexDescriptor: "search_body",
				searchField: "body",
				filterFields: [],
			},
		],
	}),
]);
const parsed = parseExportedSchema(exported);

const plainExported = schema([
	table({ name: "channels", fields: { name: field(v.string()) } }),
]);
const plainParsed = parseExportedSchema(plainExported);

const channelLine = `{"_id":"chan1","_creationTime":1792787860912.0713,"name":"general"}`;
const messageLine = `{"_id":"msg1","_creationTime":1792787860912.5,"channel":"chan1","body":"hello","big":${BIG_INT}}`;

let work: string;
/** A Convex project root: `convex/schema.ts` plus an extracted export. */
let project: string;
let exportDir: string;
let exportZip: string;

/**
 * Write a stand-in `schema.ts`. `loadConvexSchema` only needs a default export
 * whose `export()` returns the JSON string, so no `convex` import is needed.
 */
function writeSchemaTs(path: string, value: ExportedSchema): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(
		path,
		`export default { export: () => ${JSON.stringify(JSON.stringify(value))} };\n`,
	);
}

beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "c2pg-cli-"));
	project = join(work, "project");
	writeSchemaTs(join(project, "convex", "schema.ts"), exported);
	writeSchemaTs(join(project, "plain", "schema.ts"), plainExported);

	exportDir = join(project, "export");
	mkdirSync(join(exportDir, "channels"), { recursive: true });
	mkdirSync(join(exportDir, "messages"), { recursive: true });
	writeFileSync(
		join(exportDir, "channels", "documents.jsonl"),
		`${channelLine}\n`,
	);
	writeFileSync(
		join(exportDir, "messages", "documents.jsonl"),
		`${messageLine}\n`,
	);

	exportZip = join(project, "snapshot.zip");
	writeFileSync(
		exportZip,
		zipSync({
			"channels/documents.jsonl": strToU8(`${channelLine}\n`),
			"messages/documents.jsonl": strToU8(`${messageLine}\n`),
		}),
	);
});

afterAll(() => {
	rmSync(work, { recursive: true, force: true });
});

async function run(
	args: string[],
	{ cwd = project, env = {} }: { cwd?: string; env?: CliIo["env"] } = {},
) {
	let stdout = "";
	let stderr = "";
	const code = await runCli(args, {
		stdout: { write: (chunk: string) => (stdout += chunk) },
		stderr: { write: (chunk: string) => (stderr += chunk) },
		env,
		cwd,
	});
	return { code, stdout, stderr };
}

describe("runCli", () => {
	test("--help prints the top-level help to stdout", async () => {
		expect(await run(["--help"])).toEqual({
			code: 0,
			stdout: TOP_HELP,
			stderr: "",
		});
	});

	test("no command prints the help to stderr and fails", async () => {
		expect(await run([])).toEqual({
			code: 1,
			stdout: "",
			stderr: TOP_HELP,
		});
	});

	test("--version prints the package version", async () => {
		const pkg = JSON.parse(
			readFileSync(
				new URL("../../package.json", import.meta.url),
				"utf8",
			),
		) as { version: string };
		const { code, stdout } = await run(["--version"]);
		expect(code).toBe(0);
		expect(stdout).toBe(`${pkg.version}\n`);
	});

	test("an unknown command lists the valid ones", async () => {
		const { code, stderr } = await run(["frob"]);
		expect(code).toBe(1);
		expect(stderr).toContain(
			'Unknown command "frob". Expected one of: schema, seed, import.',
		);
		expect(stderr).toContain("npx @neon/convex-to-postgres --help");
	});

	test("an option before the command asks for the command first", async () => {
		const { code, stderr } = await run(["--id-strategy", "text", "schema"]);
		expect(code).toBe(1);
		expect(stderr).toContain("Put the command first");
	});

	test.each([
		"schema",
		"seed",
		"import",
	] as const)("%s --help prints that command's help", async (command) => {
		expect(await run([command, "--help"])).toEqual({
			code: 0,
			stdout: COMMAND_HELP[command],
			stderr: "",
		});
		expect((await run([command, "-h"])).stdout).toBe(COMMAND_HELP[command]);
	});

	test("an unknown flag fails and points at the command's --help", async () => {
		const { code, stderr } = await run(["schema", "--bogus"]);
		expect(code).toBe(1);
		expect(stderr).toContain("Unknown option '--bogus'");
		expect(stderr).toContain("npx @neon/convex-to-postgres schema --help");
	});

	test("a positional argument is rejected", async () => {
		const { code, stderr } = await run(["seed", "snapshot.zip"]);
		expect(code).toBe(1);
		expect(stderr).toContain("snapshot.zip");
	});
});

describe("schema", () => {
	test("prints the DDL for ./convex/schema.ts to stdout and warnings to stderr", async () => {
		const ddl = generateDdl(parsed);
		const { code, stdout, stderr } = await run(["schema"]);
		expect(code).toBe(0);
		expect(stdout).toBe(ddl.sql);
		expect(ddl.warnings.length).toBeGreaterThan(0);
		for (const warning of ddl.warnings) {
			expect(stderr).toContain(`warning: ${warning}\n`);
		}
	});

	test("maps generation flags onto the generator options", async () => {
		const options: GenerateOptions = {
			idStrategy: "text",
			snakeCase: false,
			searchLanguage: "simple",
			searchK1: 2,
		};
		const { stdout } = await run([
			"schema",
			"--id-strategy",
			"text",
			"--no-snake-case",
			"--search-language",
			"simple",
			"--search-k1",
			"2",
		]);
		expect(stdout).toBe(generateDdl(parsed, options).sql);
		expect(stdout).not.toBe(generateDdl(parsed).sql);
	});

	test("--schema points at another schema file", async () => {
		const { stdout } = await run(["schema", "--schema", "plain/schema.ts"]);
		expect(stdout).toBe(generateDdl(plainParsed).sql);
	});

	test("--out writes the SQL to a file instead of stdout", async () => {
		const { code, stdout, stderr } = await run([
			"schema",
			"--out",
			"schema.sql",
		]);
		expect(code).toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toContain("Wrote schema.sql");
		expect(readFileSync(join(project, "schema.sql"), "utf8")).toBe(
			generateDdl(parsed).sql,
		);
	});

	test("a missing default schema names --schema", async () => {
		const { code, stderr } = await run(["schema"], { cwd: work });
		expect(code).toBe(1);
		expect(stderr).toContain("No Convex schema at ./convex/schema.ts");
		expect(stderr).toContain("--schema <path>");
	});

	test("a missing --schema path is reported as given", async () => {
		const { code, stderr } = await run(["schema", "--schema", "nope.ts"]);
		expect(code).toBe(1);
		expect(stderr).toContain("No Convex schema at nope.ts");
	});
});

describe("seed", () => {
	test("prints the seed script for an extracted export", async () => {
		const { code, stdout, stderr } = await run([
			"seed",
			"--export",
			"export",
		]);
		expect(code).toBe(0);
		expect(stdout).toBe(generateSeedSql(parsed, exportDir));
		// The big integer is embedded verbatim, never rounded through JS.
		expect(stdout).toContain(`"big":${BIG_INT}`);
		expect(stderr).toContain("warning: ");
	});

	test("a .zip export produces the same script as the extracted directory", async () => {
		const fromZip = await run(["seed", "--export", "snapshot.zip"]);
		expect(fromZip.code).toBe(0);
		expect(fromZip.stdout).toBe(generateSeedSql(parsed, exportDir));
	});

	test("--out writes the script to a file", async () => {
		const { stdout } = await run([
			"seed",
			"--export",
			"export",
			"--out",
			"seed.sql",
		]);
		expect(stdout).toBe("");
		expect(readFileSync(join(project, "seed.sql"), "utf8")).toBe(
			generateSeedSql(parsed, exportDir),
		);
	});

	test("a missing --export names the flag", async () => {
		const { code, stderr } = await run(["seed"]);
		expect(code).toBe(1);
		expect(stderr).toContain("Missing --export");
		expect(stderr).toContain("npx @neon/convex-to-postgres seed --help");
	});

	test("an --export path that does not exist is reported", async () => {
		const { code, stderr } = await run(["seed", "--export", "gone.zip"]);
		expect(code).toBe(1);
		expect(stderr).toContain("No export at gone.zip");
	});

	test("--out and --split are mutually exclusive", async () => {
		const { code, stderr } = await run([
			"seed",
			"--export",
			"export",
			"--out",
			"seed.sql",
			"--split",
			"mig",
		]);
		expect(code).toBe(1);
		expect(stderr).toContain("not both");
	});

	test("--force needs --split", async () => {
		const { code, stderr } = await run([
			"seed",
			"--export",
			"export",
			"--force",
		]);
		expect(code).toBe(1);
		expect(stderr).toContain("--force only applies with --split");
	});
});

describe("seed --split", () => {
	const read = (dir: string, file: string) =>
		readFileSync(join(project, dir, file), "utf8");

	test("writes the four step files and nothing to stdout", async () => {
		const { code, stdout, stderr } = await run([
			"seed",
			"--export",
			"snapshot.zip",
			"--split",
			"mig",
		]);
		expect(code).toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toContain(
			"Wrote 01-schema.sql, 02-load.sql, 03-transform.sql, 04-indexes.sql to mig/",
		);
		expect(stderr).toContain("ON_ERROR_STOP=1");
		expect(stderr).toContain("warning: ");

		const schemaSql = read("mig", SPLIT_FILES.schema);
		expect(schemaSql).toContain(generateDdl(parsed).sql);

		// Staging tables and raw rows, committed so they outlive the file.
		const load = read("mig", SPLIT_FILES.load);
		expect(load).toContain(
			`BEGIN;\n\n${generateDataSql(parsed, exportDir)}\nCOMMIT;\n`,
		);
		expect(load).toContain(`"big":${BIG_INT}`);
		expect(load).not.toContain("DROP TABLE");

		// The editable transform drops the staging tables it read from.
		const transform = read("mig", SPLIT_FILES.transform);
		expect(transform).toContain(generateTransformSql(parsed).trimEnd());
		expect(transform).toContain(generateStagingDropSql(parsed).trimEnd());
		expect(transform).not.toContain("CREATE TABLE _convex_");
		expect(transform.trimEnd().endsWith("COMMIT;")).toBe(true);

		// Search/vector indexes run after the load, outside any transaction.
		const indexes = read("mig", SPLIT_FILES.indexes);
		expect(indexes).toContain(generateIndexDdl(parsed).trimEnd());
		expect(indexes).toContain("lakebase_bm25");
		expect(indexes).not.toContain("BEGIN;");
		expect(indexes.trimEnd().endsWith("VACUUM ANALYZE;")).toBe(true);
	});

	test("the step files hold the same SQL as the one-file seed script", async () => {
		await run(["seed", "--export", "export", "--split", "same"]);
		const seed = generateSeedSql(parsed, exportDir);
		for (const piece of [
			generateDataSql(parsed, exportDir).trimEnd(),
			generateTransformSql(parsed).trimEnd(),
			generateStagingDropSql(parsed).trimEnd(),
			generateIndexDdl(parsed).trimEnd(),
		]) {
			expect(seed).toContain(piece);
		}
		expect(read("same", SPLIT_FILES.load)).toContain(
			generateDataSql(parsed, exportDir).trimEnd(),
		);
	});

	test("omits 04-indexes.sql when the schema has no search or vector index", async () => {
		const { stderr } = await run([
			"seed",
			"--schema",
			"plain/schema.ts",
			"--export",
			"export",
			"--split",
			"plain-mig",
		]);
		expect(stderr).toContain(
			"Wrote 01-schema.sql, 02-load.sql, 03-transform.sql to plain-mig/",
		);
		expect(
			existsSync(join(project, "plain-mig", SPLIT_FILES.indexes)),
		).toBe(false);
	});

	test("refuses to overwrite an earlier run's files without --force", async () => {
		await run(["seed", "--export", "export", "--split", "rerun"]);
		const edited = join(project, "rerun", SPLIT_FILES.transform);
		writeFileSync(edited, "-- my edits\n");

		const refused = await run([
			"seed",
			"--export",
			"export",
			"--split",
			"rerun",
		]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("already has 01-schema.sql");
		expect(refused.stderr).toContain("--force");
		expect(readFileSync(edited, "utf8")).toBe("-- my edits\n");

		const forced = await run([
			"seed",
			"--export",
			"export",
			"--split",
			"rerun",
			"--force",
		]);
		expect(forced.code).toBe(0);
		expect(readFileSync(edited, "utf8")).toContain(
			generateTransformSql(parsed).trimEnd(),
		);
	});

	test("--force removes a stale 04-indexes.sql the schema no longer needs", async () => {
		await run(["seed", "--export", "export", "--split", "stale"]);
		expect(existsSync(join(project, "stale", SPLIT_FILES.indexes))).toBe(
			true,
		);
		await run([
			"seed",
			"--schema",
			"plain/schema.ts",
			"--export",
			"export",
			"--split",
			"stale",
			"--force",
		]);
		expect(existsSync(join(project, "stale", SPLIT_FILES.indexes))).toBe(
			false,
		);
	});
});

describe("import", () => {
	test("without --database-url or DATABASE_URL, names both", async () => {
		const { code, stderr } = await run(["import", "--export", "export"]);
		expect(code).toBe(1);
		expect(stderr).toContain(
			"Pass --database-url <url> or set DATABASE_URL.",
		);
	});

	test("an empty DATABASE_URL counts as unset", async () => {
		const { stderr } = await run(["import", "--export", "export"], {
			env: { DATABASE_URL: "" },
		});
		expect(stderr).toContain(
			"Pass --database-url <url> or set DATABASE_URL.",
		);
	});

	test("a missing --export names the flag", async () => {
		const { code, stderr } = await run(["import"], {
			env: { DATABASE_URL: "postgres://localhost/db" },
		});
		expect(code).toBe(1);
		expect(stderr).toContain("Missing --export");
	});

	test("falls back to DATABASE_URL and reports a connection failure", async () => {
		// Port 1 refuses immediately: this proves the env URL reached the client
		// without needing a database.
		const { code, stderr } = await run(["import", "--export", "export"], {
			env: { DATABASE_URL: "postgres://c2p:c2p@127.0.0.1:1/c2p" },
		});
		expect(code).toBe(1);
		expect(stderr).toContain("convex-to-postgres: ");
		expect(stderr).not.toContain("DATABASE_URL");
		expect(stderr).not.toContain("--help");
	});
});
