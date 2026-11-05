import type {
	GenerateOptions,
	IdStrategy,
	SearchIndexKind,
} from "../options.js";

/** How the package is run; used in help text and in "run --help" hints. */
export const INVOCATION = "npx @neon/convex-to-postgres";

/** The default `--schema`, relative to the working directory. */
export const DEFAULT_SCHEMA = "convex/schema.ts";

export const COMMANDS = ["schema", "seed", "import"] as const;
export type Command = (typeof COMMANDS)[number];

/**
 * A mistake in how the CLI was invoked (a missing, unknown, or malformed flag).
 * The message names the flag to pass; `command` picks which `--help` to point at.
 */
export class CliUsageError extends Error {
	constructor(
		message: string,
		readonly command?: Command,
	) {
		super(message);
		this.name = "CliUsageError";
	}
}

/**
 * `node:util` `parseArgs` config for the {@link GenerateOptions} flags every
 * command accepts. The two negations are spelled out as their own booleans
 * because `parseArgs` only learned `allowNegative` in Node 22.4 / 20.16.
 */
export const GENERATE_OPTION_FLAGS = {
	"id-strategy": { type: "string" },
	"no-snake-case": { type: "boolean" },
	"no-check-constraints": { type: "boolean" },
	"search-index": { type: "string" },
	"search-language": { type: "string" },
	"vector-ops": { type: "string" },
	"search-k1": { type: "string" },
	"search-b": { type: "string" },
	"max-ann-dimensions": { type: "string" },
} as const;

export interface GenerateOptionValues {
	"id-strategy"?: string;
	"no-snake-case"?: boolean;
	"no-check-constraints"?: boolean;
	"search-index"?: string;
	"search-language"?: string;
	"vector-ops"?: string;
	"search-k1"?: string;
	"search-b"?: string;
	"max-ann-dimensions"?: string;
}

const ID_STRATEGIES: readonly IdStrategy[] = ["uuid", "text"];
const SEARCH_INDEX_KINDS: readonly SearchIndexKind[] = ["bm25", "gin"];

/**
 * Map parsed generation flags onto {@link GenerateOptions}. Omitted flags stay
 * `undefined` so the library defaults apply. Throws {@link CliUsageError} naming
 * the flag when a value is invalid.
 */
export function parseGenerateOptions(
	values: GenerateOptionValues,
	command?: Command,
): GenerateOptions {
	const options: GenerateOptions = {};

	const idStrategy = values["id-strategy"];
	if (idStrategy !== undefined) {
		if (!ID_STRATEGIES.includes(idStrategy as IdStrategy)) {
			throw new CliUsageError(
				`Invalid --id-strategy "${idStrategy}". Pass --id-strategy uuid or --id-strategy text.`,
				command,
			);
		}
		options.idStrategy = idStrategy as IdStrategy;
	}
	if (values["no-snake-case"]) options.snakeCase = false;
	if (values["no-check-constraints"]) options.checkConstraints = false;

	const searchIndex = values["search-index"];
	if (searchIndex !== undefined) {
		if (!SEARCH_INDEX_KINDS.includes(searchIndex as SearchIndexKind)) {
			throw new CliUsageError(
				`Invalid --search-index "${searchIndex}". Pass --search-index bm25 or --search-index gin.`,
				command,
			);
		}
		options.searchIndex = searchIndex as SearchIndexKind;
	}

	const searchLanguage = values["search-language"];
	if (searchLanguage !== undefined) {
		options.searchLanguage = nonEmpty(
			"search-language",
			searchLanguage,
			command,
		);
	}
	const vectorOps = values["vector-ops"];
	if (vectorOps !== undefined) {
		options.vectorOps = nonEmpty("vector-ops", vectorOps, command);
	}

	// k1 and b tune BM25 only; a GIN index has no equivalent, so passing them
	// with gin is a mistake rather than something to ignore silently.
	for (const flag of ["search-k1", "search-b"] as const) {
		if (values[flag] !== undefined && options.searchIndex === "gin") {
			throw new CliUsageError(
				`--${flag} doesn't apply with --search-index gin.`,
				command,
			);
		}
	}
	const searchK1 = values["search-k1"];
	if (searchK1 !== undefined) {
		options.searchK1 = nonNegativeNumber(
			"search-k1",
			searchK1,
			"1.2",
			command,
		);
	}
	const searchB = values["search-b"];
	if (searchB !== undefined) {
		options.searchB = nonNegativeNumber(
			"search-b",
			searchB,
			"0.75",
			command,
		);
	}
	const maxAnnDimensions = values["max-ann-dimensions"];
	if (maxAnnDimensions !== undefined) {
		const n = Number(maxAnnDimensions);
		if (!Number.isInteger(n) || n < 1) {
			throw new CliUsageError(
				`Invalid --max-ann-dimensions "${maxAnnDimensions}". Pass a positive whole number, e.g. --max-ann-dimensions 2000.`,
				command,
			);
		}
		options.maxAnnDimensions = n;
	}

	return options;
}

function nonEmpty(flag: string, value: string, command?: Command): string {
	if (value.trim().length === 0) {
		throw new CliUsageError(`--${flag} needs a value.`, command);
	}
	return value;
}

function nonNegativeNumber(
	flag: string,
	value: string,
	example: string,
	command?: Command,
): number {
	const n = value.trim().length === 0 ? Number.NaN : Number(value);
	if (!Number.isFinite(n) || n < 0) {
		throw new CliUsageError(
			`Invalid --${flag} "${value}". Pass a number, e.g. --${flag} ${example}.`,
			command,
		);
	}
	return n;
}

const GENERATE_OPTIONS_HELP = `Generation options (pass the same ones to every command):
  --id-strategy <uuid|text>   How a Convex _id becomes a key (default: uuid)
  --no-snake-case             Keep Convex names verbatim instead of snake_case
  --no-check-constraints      Omit the CHECK constraint on string-literal unions
  --search-index <bm25|gin>   Index for search indexes: Lakebase BM25, or a
                              stock Postgres GIN index that needs no
                              extension (default: bm25)
  --search-language <config>  Text-search configuration for search indexes
                              (default: english)
  --search-k1 <number>        BM25 k1 for search indexes (default: 1.2)
  --search-b <number>         BM25 b for search indexes (default: 0.75)
  --vector-ops <opclass>      Operator class for vector indexes
                              (default: vector_cosine_ops)
  --max-ann-dimensions <n>    Skip the vector index above n dimensions
                              (default: no cap)`;

const SCHEMA_FLAG_HELP = `  --schema <path>             Convex schema file (default: ./${DEFAULT_SCHEMA})`;
const EXPORT_FLAG_HELP = `  --export <path>             Snapshot from \`npx convex export\`: a .zip or
                              an extracted directory (required)`;

export const TOP_HELP = `Migrate a Convex deployment to Neon Postgres.

Usage: ${INVOCATION} <command> [options]

Commands:
  schema   Print the Postgres DDL for a Convex schema.ts
  seed     Print a SQL script that loads a \`convex export\` snapshot
  import   Load a \`convex export\` snapshot straight into Postgres

Run \`${INVOCATION} <command> --help\` for a command's options.

Options:
  -h, --help     Show help
  --version      Show the version
`;

export const COMMAND_HELP: Record<Command, string> = {
	schema: `Usage: ${INVOCATION} schema [options]

Print the Postgres DDL for a Convex schema: extensions, CREATE TABLE, foreign
keys, and btree indexes. Search and vector indexes are built after the data
load, by \`seed\` and \`import\`. Warnings (the things to review by hand) go to
stderr, so stdout is pure SQL.

Options:
${SCHEMA_FLAG_HELP}
  --out <file>                Write the SQL to a file instead of stdout
  -h, --help                  Show help

${GENERATE_OPTIONS_HELP}
`,
	seed: `Usage: ${INVOCATION} seed --export <path> [options]

Print one SQL script that loads a \`convex export\` snapshot into the tables
\`schema\` creates: staging tables, the raw documents, and the typed transform
in one transaction. When the schema has search or vector indexes, the script
then builds them and runs VACUUM ANALYZE.

With --split, write the steps as separate files to edit before running them in
order: 01-schema.sql, 02-load.sql, 03-transform.sql, and 04-indexes.sql when
the schema has search or vector indexes. Change the schema in 01-schema.sql,
then make the matching change to a SELECT expression in 03-transform.sql.

Options:
${EXPORT_FLAG_HELP}
${SCHEMA_FLAG_HELP}
  --out <file>                Write the script to a file instead of stdout
  --split <dir>               Write the editable step files to <dir>
  --force                     With --split, overwrite files from an earlier run
  -h, --help                  Show help

${GENERATE_OPTIONS_HELP}
`,
	import: `Usage: ${INVOCATION} import --export <path> [options]

Load a \`convex export\` snapshot into Postgres in one transaction. When the
schema has search or vector indexes, it then builds them and runs VACUUM
ANALYZE. Progress and row counts go to stderr.

Options:
${EXPORT_FLAG_HELP}
${SCHEMA_FLAG_HELP}
  --database-url <url>        Postgres connection string (default: $DATABASE_URL)
  --apply-schema              Create the tables first; without it they must exist
  -h, --help                  Show help

${GENERATE_OPTIONS_HELP}
`,
};
