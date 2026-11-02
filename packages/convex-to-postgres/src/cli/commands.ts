import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { importConvexExport } from "../data/import.js";
import { generateDataSql, generateSeedSql } from "../data/seed.js";
import { generateStagingDropSql } from "../data/staging.js";
import { generateTransformSql } from "../data/transform.js";
import type { GenerateOptions } from "../options.js";
import { generateDdl, generateIndexDdl } from "../schema/generate-ddl.js";
import { loadConvexSchema } from "../schema/load.js";
import type { ConvexSchema } from "../schema/model.js";
import { withExtractedExport } from "./export-dir.js";
import {
	CliUsageError,
	COMMAND_HELP,
	COMMANDS,
	type Command,
	DEFAULT_SCHEMA,
	GENERATE_OPTION_FLAGS,
	INVOCATION,
	parseGenerateOptions,
	TOP_HELP,
} from "./options.js";

/**
 * Everything a command touches outside its arguments. Injected so tests drive
 * the commands with captured streams and a temporary `cwd`, without spawning.
 */
export interface CliIo {
	stdout: { write(chunk: string): unknown };
	stderr: { write(chunk: string): unknown };
	env: Record<string, string | undefined>;
	cwd: string;
}

/** The files `seed --split` writes, in the order they run. */
export const SPLIT_FILES = {
	schema: "01-schema.sql",
	load: "02-load.sql",
	transform: "03-transform.sql",
	indexes: "04-indexes.sql",
} as const;

/**
 * Run the CLI with `args` (no `node` or script path) and return the exit code.
 * Never throws: failures are written to `io.stderr` and return `1`.
 */
export async function runCli(args: string[], io: CliIo): Promise<number> {
	try {
		return await dispatch(args, io);
	} catch (error) {
		io.stderr.write(formatError(error));
		return 1;
	}
}

async function dispatch(args: string[], io: CliIo): Promise<number> {
	const [command, ...rest] = args;
	switch (command) {
		case undefined:
			io.stderr.write(TOP_HELP);
			return 1;
		case "-h":
		case "--help":
		case "help":
			io.stdout.write(TOP_HELP);
			return 0;
		case "--version":
			io.stdout.write(`${packageVersion()}\n`);
			return 0;
		case "schema":
			return runSchema(rest, io);
		case "seed":
			return runSeed(rest, io);
		case "import":
			return runImport(rest, io);
		default:
			throw new CliUsageError(
				command.startsWith("-")
					? `Put the command first: ${INVOCATION} <${COMMANDS.join("|")}> ${command} ...`
					: `Unknown command "${command}". Expected one of: ${COMMANDS.join(", ")}.`,
			);
	}
}

/** `schema`: print the pre-load DDL; warnings go to stderr. */
export async function runSchema(args: string[], io: CliIo): Promise<number> {
	const values = parseCommandArgs("schema", args, {
		schema: { type: "string" },
		out: { type: "string" },
	});
	if (values.help) return help("schema", io);

	const options = parseGenerateOptions(values, "schema");
	const schema = await readSchema(values.schema, "schema", io);
	const ddl = generateDdl(schema, options);
	emit(ddl.sql, values.out, io);
	writeWarnings(ddl.warnings, io);
	return 0;
}

/** `seed`: print one self-contained seed script, or the `--split` step files. */
export async function runSeed(args: string[], io: CliIo): Promise<number> {
	const values = parseCommandArgs("seed", args, {
		export: { type: "string" },
		schema: { type: "string" },
		out: { type: "string" },
		split: { type: "string" },
		force: { type: "boolean" },
	});
	if (values.help) return help("seed", io);

	const exportPath = requireExport(values.export, "seed", io);
	if (values.out !== undefined && values.split !== undefined) {
		throw new CliUsageError(
			"Pass either --out <file> (one script) or --split <dir> (step files), not both.",
			"seed",
		);
	}
	if (values.force && values.split === undefined) {
		throw new CliUsageError(
			"--force only applies with --split <dir>.",
			"seed",
		);
	}
	const options = parseGenerateOptions(values, "seed");
	const schema = await readSchema(values.schema, "seed", io);
	const ddl = generateDdl(schema, options);

	if (values.split !== undefined) {
		const splitDir = values.split;
		const target = prepareSplitDir(splitDir, values.force ?? false, io);
		const written = await withExtractedExport(exportPath, (exportDir) =>
			writeSplitFiles(target, schema, exportDir, options, ddl.sql),
		);
		io.stderr.write(splitSummary(splitDir, written));
	} else {
		const sql = await withExtractedExport(exportPath, (exportDir) =>
			generateSeedSql(schema, exportDir, options),
		);
		emit(sql, values.out, io);
	}
	writeWarnings(ddl.warnings, io);
	return 0;
}

/** `import`: load the snapshot through `pg`; progress and counts go to stderr. */
export async function runImport(args: string[], io: CliIo): Promise<number> {
	const values = parseCommandArgs("import", args, {
		export: { type: "string" },
		schema: { type: "string" },
		"database-url": { type: "string" },
		"apply-schema": { type: "boolean" },
	});
	if (values.help) return help("import", io);

	const connectionString = values["database-url"] ?? io.env.DATABASE_URL;
	if (connectionString === undefined || connectionString.length === 0) {
		throw new CliUsageError(
			"No database to import into. Pass --database-url <url> or set DATABASE_URL.",
			"import",
		);
	}
	const exportPath = requireExport(values.export, "import", io);
	const options = parseGenerateOptions(values, "import");
	const schema = await readSchema(values.schema, "import", io);

	const result = await importConvexExport({
		...options,
		schema,
		source: exportPath,
		connectionString,
		applySchema: values["apply-schema"] ?? false,
		log: (message) => io.stderr.write(`${message}\n`),
	});

	const counts = Object.values(result.tables);
	const rows = counts.reduce((sum, n) => sum + n, 0);
	io.stderr.write(
		`Imported ${rows} row(s) into ${counts.length} table(s).\n`,
	);
	writeWarnings(result.warnings, io);
	return 0;
}

type FlagConfig = Record<string, { type: "string" | "boolean" }>;

/**
 * Parse a command's flags plus the shared generation flags and `--help`,
 * rethrowing `parseArgs` errors as a {@link CliUsageError} for that command.
 */
function parseCommandArgs<T extends FlagConfig>(
	command: Command,
	args: string[],
	flags: T,
) {
	try {
		return parseArgs({
			args,
			options: {
				...flags,
				...GENERATE_OPTION_FLAGS,
				help: { type: "boolean", short: "h" },
			},
			strict: true,
			allowPositionals: false,
		}).values;
	} catch (error) {
		if (isParseArgsError(error)) {
			throw new CliUsageError(`${error.message}.`, command);
		}
		throw error;
	}
}

function isParseArgsError(error: unknown): error is Error {
	if (!(error instanceof Error)) return false;
	const { code } = error as { code?: unknown };
	return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

function help(command: Command, io: CliIo): number {
	io.stdout.write(COMMAND_HELP[command]);
	return 0;
}

function requireExport(
	value: string | undefined,
	command: Command,
	io: CliIo,
): string {
	if (value === undefined) {
		throw new CliUsageError(
			"Missing --export. Pass the snapshot from `npx convex export`, e.g. --export snapshot.zip.",
			command,
		);
	}
	const path = resolve(io.cwd, value);
	if (!existsSync(path)) {
		throw new CliUsageError(
			`No export at ${value}. Check the --export path.`,
			command,
		);
	}
	return path;
}

async function readSchema(
	value: string | undefined,
	command: Command,
	io: CliIo,
): Promise<ConvexSchema> {
	const path = resolve(io.cwd, value ?? DEFAULT_SCHEMA);
	if (!existsSync(path)) {
		throw new CliUsageError(
			value === undefined
				? `No Convex schema at ./${DEFAULT_SCHEMA}. Run from your Convex project root, or pass --schema <path>.`
				: `No Convex schema at ${value}. Check the --schema path.`,
			command,
		);
	}
	return loadConvexSchema(path);
}

/** Write `sql` to `--out` when given, else stdout. */
function emit(sql: string, out: string | undefined, io: CliIo): void {
	if (out === undefined) {
		io.stdout.write(sql);
		return;
	}
	writeFileSync(resolve(io.cwd, out), sql);
	io.stderr.write(`Wrote ${out}\n`);
}

function writeWarnings(warnings: string[], io: CliIo): void {
	for (const warning of warnings) {
		io.stderr.write(`warning: ${warning}\n`);
	}
}

/**
 * Resolve `--split <dir>` and refuse to overwrite an earlier run's files unless
 * `--force` is passed: the point of `--split` is hand-editing them, and a rerun
 * would silently discard those edits.
 */
function prepareSplitDir(splitDir: string, force: boolean, io: CliIo): string {
	const dir = resolve(io.cwd, splitDir);
	const existing = Object.values(SPLIT_FILES).filter((file) =>
		existsSync(join(dir, file)),
	);
	if (existing.length > 0 && !force) {
		throw new CliUsageError(
			`${splitDir} already has ${existing.join(", ")}. Pass --force to overwrite (this discards any edits), or choose another --split directory.`,
			"seed",
		);
	}
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Write the `--split` step files and return their names. The staging tables
 * created by `02-load.sql` persist until `03-transform.sql` drops them, so the
 * files run as separate `psql` invocations, in order.
 */
function writeSplitFiles(
	dir: string,
	schema: ConvexSchema,
	exportDir: string,
	options: GenerateOptions,
	schemaSql: string,
): string[] {
	const files: Array<[string, string]> = [
		[
			SPLIT_FILES.schema,
			[
				"-- Step 1: create the target tables. Edit freely, then make the matching",
				"-- change to the SELECT in 03-transform.sql.",
				"",
				schemaSql,
			].join("\n"),
		],
		[
			SPLIT_FILES.load,
			[
				"-- Step 2: stage the raw Convex documents as jsonb. This does not depend on",
				"-- the target schema, so it never needs editing.",
				"",
				"BEGIN;",
				"",
				generateDataSql(schema, exportDir, options),
				"COMMIT;",
				"",
			].join("\n"),
		],
		[
			SPLIT_FILES.transform,
			[
				"-- Step 3: copy the staged documents into the typed tables, then drop the",
				"-- staging tables. Each SELECT reads the original document from",
				"-- _convex_<table>.doc, so a change made in 01-schema.sql is one edited",
				"-- expression here.",
				"",
				"BEGIN;",
				"",
				generateTransformSql(schema, options).trimEnd(),
				"",
				generateStagingDropSql(schema, options).trimEnd(),
				"",
				"COMMIT;",
				"",
			].join("\n"),
		],
	];

	const indexSql = generateIndexDdl(schema, options).trimEnd();
	const indexesPath = join(dir, SPLIT_FILES.indexes);
	if (indexSql.length > 0) {
		files.push([
			SPLIT_FILES.indexes,
			[
				"-- Step 4: build the search/vector indexes now that the data is loaded.",
				"-- Run outside a transaction: VACUUM cannot run inside one.",
				"",
				indexSql,
				"",
				"VACUUM ANALYZE;",
				"",
			].join("\n"),
		]);
	} else {
		// Left over from a --force rerun against a schema that had indexes.
		rmSync(indexesPath, { force: true });
	}

	for (const [name, sql] of files) {
		writeFileSync(join(dir, name), sql);
	}
	return files.map(([name]) => name);
}

function splitSummary(splitDir: string, written: string[]): string {
	const dir = splitDir.replace(/\/+$/, "");
	return [
		`Wrote ${written.join(", ")} to ${dir}/`,
		"Edit them as needed, then run them in order:",
		// The subshell's `set -e` stops at the first failing file and exits with
		// psql's non-zero status, without closing an interactive shell.
		`  (set -e; for f in ${dir}/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done)`,
		"",
	].join("\n");
}

function formatError(error: unknown): string {
	const lines = [
		`convex-to-postgres: ${error instanceof Error ? error.message : String(error)}`,
	];
	// node-postgres errors carry Postgres's own DETAIL / HINT, which name the
	// offending row for a foreign-key or constraint violation.
	if (typeof error === "object" && error !== null) {
		const { detail, hint } = error as { detail?: unknown; hint?: unknown };
		if (typeof detail === "string") lines.push(`  detail: ${detail}`);
		if (typeof hint === "string") lines.push(`  hint: ${hint}`);
	}
	if (error instanceof CliUsageError) {
		lines.push(
			`Run \`${INVOCATION}${error.command === undefined ? "" : ` ${error.command}`} --help\` for usage.`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function packageVersion(): string {
	// `src/cli/commands.ts` and `dist/cli/commands.js` are both two levels below
	// the package root, so one relative URL covers source and build.
	const raw = readFileSync(
		new URL("../../package.json", import.meta.url),
		"utf8",
	);
	return (JSON.parse(raw) as { version: string }).version;
}
