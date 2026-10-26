import type { GenerateOptions, ResolvedOptions } from "../options.js";
import { resolveOptions } from "../options.js";
import { quoteIdentIfNeeded, toPgName } from "../util/names.js";
import {
	jsonTextAccessor,
	jsonValueAccessor,
	quoteSqlString,
} from "../util/sql.js";
import type { SelectKind } from "./map-types.js";
import { mapValidator } from "./map-types.js";
import type { ConvexSchema, ConvexTable, ConvexValidator } from "./model.js";

/** A fully-resolved Postgres column derived from a Convex field. */
export interface PlannedColumn {
	/** Original Convex field name (`_id` / `_creationTime` for synthesized, `""` for the schemaless `doc`). */
	convexName: string;
	/** Postgres column name (snake_cased or verbatim per options). */
	pgName: string;
	pgType: string;
	notNull: boolean;
	isPrimaryKey: boolean;
	/** Target Postgres table name when this column is a resolved foreign key. */
	references?: string;
	/** String-literal values for a `CHECK (col IN (...))` constraint. */
	checkIn?: string[];
	/** SQL expression that reads this column's value out of the staged `doc jsonb`. */
	selectExpr: string;
	/**
	 * `true` for a STORED GENERATED column Postgres computes itself — the
	 * `tsvector` backing a Lakebase BM25 index. The transform skips it (Postgres
	 * fills it); the DDL emits a `GENERATED ALWAYS AS (...) STORED` clause from
	 * {@link generatedExpr}.
	 */
	generated?: true;
	/** The SQL body of a generated column's `GENERATED ALWAYS AS (<expr>) STORED`. */
	generatedExpr?: string;
}

export interface PlannedIndex {
	/** Raw index name (`<pgTable>_<indexDescriptor>`, `<pgTable>_<col>_bm25`, ...). */
	name: string;
	/** Postgres column names covered by the index, in order. */
	columns: string[];
	/**
	 * `btree` for a plain index, `bm25` for a Lakebase full-text index over a
	 * generated `tsvector` column, `ann` for a Lakebase approximate-nearest-
	 * neighbour index over a `vector` column.
	 */
	kind: "btree" | "bm25" | "ann";
	/** `ann` only: the pgvector operator class (e.g. `vector_cosine_ops`). */
	opclass?: string;
	/** `bm25` only: the BM25 `k1` term-frequency saturation parameter. */
	k1?: number;
	/** `bm25` only: the BM25 `b` length-normalization parameter. */
	b?: number;
}

export interface PlannedTable {
	convexName: string;
	pgName: string;
	/** Raw name of the per-table jsonb staging table (`_convex_<pgName>`). */
	stagingName: string;
	columns: PlannedColumn[];
	/** Plain btree indexes, created pre-load as part of the schema DDL. */
	indexes: PlannedIndex[];
	/**
	 * Lakebase BM25/ANN indexes plus the btree indexes backing search/vector
	 * filter fields. Created AFTER the data load (better BM25 corpus statistics
	 * and ANN layout); emitted by `generateIndexDdl`, never by `generateDdl`.
	 */
	postLoadIndexes: PlannedIndex[];
}

export interface PlannedSchema {
	tables: PlannedTable[];
	/**
	 * `CREATE EXTENSION` statements this schema needs: `lakebase_vector CASCADE`
	 * when any vector index is present, `lakebase_text` when any search index is.
	 * Empty when the schema uses neither (so DDL is byte-identical to before).
	 */
	extensions: string[];
	warnings: string[];
}

/** Which Lakebase extensions a schema turned out to need, accumulated per table. */
interface ExtensionUse {
	vector: boolean;
	text: boolean;
}

/**
 * Resolve a {@link ConvexSchema} into the concrete Postgres plan shared by the
 * DDL, staging, and transform generators. Pure: no I/O, deterministic output.
 */
export function planSchema(
	schema: ConvexSchema,
	options?: GenerateOptions,
): PlannedSchema {
	const resolved = resolveOptions(options);
	const schemaTableNames = new Set(schema.tables.map((t) => t.name));
	const warnings: string[] = [];
	const uses: ExtensionUse = { vector: false, text: false };

	const tables = schema.tables.map((table) =>
		planTable(table, resolved, schemaTableNames, warnings, uses),
	);

	// Emit each extension only when the schema actually used it, in a fixed
	// order. A schema with neither produces no extension lines at all.
	const extensions: string[] = [];
	if (uses.vector) {
		extensions.push(
			"CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;",
		);
	}
	if (uses.text) {
		extensions.push("CREATE EXTENSION IF NOT EXISTS lakebase_text;");
	}

	return { tables, extensions, warnings };
}

function planTable(
	table: ConvexTable,
	options: ResolvedOptions,
	schemaTableNames: ReadonlySet<string>,
	warnings: string[],
	uses: ExtensionUse,
): PlannedTable {
	const pgName = toPgName(table.name, options.snakeCase);
	const columns: PlannedColumn[] = [idColumn(options), creationTimeColumn()];

	if (table.schemaless) {
		warnings.push(
			`table "${table.name}" has no declared field shape; falling back to id, created_at, and a single doc jsonb column.`,
		);
		columns.push({
			convexName: "",
			pgName: "doc",
			pgType: "jsonb",
			notNull: true,
			isPrimaryKey: false,
			selectExpr: "doc",
		});
	} else {
		for (const column of table.columns) {
			const mapped = mapValidator(
				column.validator,
				{ options, schemaTableNames },
				`${table.name}.${column.name}`,
			);
			for (const warning of mapped.warnings) {
				warnings.push(`table "${table.name}": ${warning}`);
			}
			columns.push({
				convexName: column.name,
				pgName: toPgName(column.name, options.snakeCase),
				pgType: mapped.pgType,
				notNull: !column.optional && !isNullableUnion(column.validator),
				isPrimaryKey: false,
				references: mapped.references,
				checkIn: options.checkConstraints ? mapped.checkIn : undefined,
				selectExpr: selectExprFor(
					mapped.selectKind,
					column.name,
					options,
				),
			});
		}
	}

	// Finalize column names before deriving vector/search columns from them: the
	// `tsvector` column name and the ANN target depend on the resolved pg name.
	dedupeColumnNames(table.name, columns, warnings);
	const columnByConvexName = new Map(
		columns.map((column) => [column.convexName, column] as const),
	);

	const annIndexes = planVectorColumns(
		table,
		pgName,
		columnByConvexName,
		options,
		warnings,
		uses,
	);
	const bm25Indexes = planSearchColumns(
		table,
		pgName,
		columns,
		columnByConvexName,
		options,
		warnings,
		uses,
	);

	// Regular btree indexes (pre-load) are planned against the final column set,
	// including any retyped vector column and the added `tsvector` columns.
	const indexes = planIndexes(table, pgName, columns, options, warnings);
	const usedNames = new Set(indexes.map((index) => index.name));
	const filterIndexes = planFilterIndexes(
		table,
		pgName,
		columns,
		options,
		warnings,
		usedNames,
	);

	return {
		convexName: table.name,
		pgName,
		stagingName: `_convex_${pgName}`,
		columns,
		indexes,
		postLoadIndexes: [...filterIndexes, ...bm25Indexes, ...annIndexes],
	};
}

/**
 * Retype each vector index's embedding column to `vector(<dimensions>)` and plan
 * a Lakebase ANN index over it. When `maxAnnDimensions` is set and exceeded, the
 * column is still retyped but the ANN index is skipped with a warning. Mutates
 * the matched column in place; returns the planned ANN indexes.
 */
function planVectorColumns(
	table: ConvexTable,
	pgTableName: string,
	columnByConvexName: ReadonlyMap<string, PlannedColumn>,
	options: ResolvedOptions,
	warnings: string[],
	uses: ExtensionUse,
): PlannedIndex[] {
	const annIndexes: PlannedIndex[] = [];
	for (const index of table.vectorIndexes) {
		const column = columnByConvexName.get(index.vectorField);
		if (column === undefined) {
			warnings.push(
				`table "${table.name}": vector index "${index.name}" references field "${index.vectorField}", which is not a materialized column; skipped.`,
			);
			continue;
		}
		column.pgType = `vector(${index.dimensions})`;
		column.selectExpr = selectExprFor("vector", column.convexName, options);
		uses.vector = true;
		if (
			options.maxAnnDimensions !== undefined &&
			index.dimensions > options.maxAnnDimensions
		) {
			warnings.push(
				`table "${table.name}": vector index "${index.name}" has ${index.dimensions} dimensions, above maxAnnDimensions=${options.maxAnnDimensions}; the column is typed vector(${index.dimensions}) but the ANN index is skipped.`,
			);
			continue;
		}
		annIndexes.push({
			name: `${pgTableName}_${column.pgName}_ann`,
			columns: [column.pgName],
			kind: "ann",
			opclass: options.vectorOps,
		});
	}
	return annIndexes;
}

/**
 * Add a STORED GENERATED `tsvector` column for each search index and plan a
 * Lakebase BM25 index over it. The `tsvector` columns are appended to `columns`;
 * returns the planned BM25 indexes.
 */
function planSearchColumns(
	table: ConvexTable,
	pgTableName: string,
	columns: PlannedColumn[],
	columnByConvexName: ReadonlyMap<string, PlannedColumn>,
	options: ResolvedOptions,
	warnings: string[],
	uses: ExtensionUse,
): PlannedIndex[] {
	const bm25Indexes: PlannedIndex[] = [];
	const seenFields = new Set<string>();
	for (const index of table.searchIndexes) {
		const column = columnByConvexName.get(index.searchField);
		if (column === undefined) {
			warnings.push(
				`table "${table.name}": search index "${index.name}" references field "${index.searchField}", which is not a materialized column; skipped.`,
			);
			continue;
		}
		// Two search indexes on the same field would emit a duplicate tsvector
		// column and BM25 index name; one column and index serve both.
		if (seenFields.has(column.pgName)) {
			warnings.push(
				`table "${table.name}": search index "${index.name}" targets field "${index.searchField}", already indexed by an earlier search index; reusing the one BM25 index.`,
			);
			continue;
		}
		seenFields.add(column.pgName);
		const tsvName = `${column.pgName}_tsv`;
		columns.push({
			convexName: "",
			pgName: tsvName,
			pgType: "tsvector",
			notNull: false,
			isPrimaryKey: false,
			generated: true,
			generatedExpr: `to_tsvector(${quoteSqlString(
				options.searchLanguage,
			)}, ${quoteIdentIfNeeded(column.pgName)})`,
			selectExpr: "",
		});
		uses.text = true;
		bm25Indexes.push({
			name: `${pgTableName}_${column.pgName}_bm25`,
			columns: [tsvName],
			kind: "bm25",
			k1: options.searchK1,
			b: options.searchB,
		});
	}
	return bm25Indexes;
}

/**
 * Plan one plain btree index per filter field of every search and vector index,
 * on the resolved pg column. Deduplicated by column and by index name, so a
 * field filtered by two indexes (or already covered by a plain `.index(...)`)
 * yields at most one btree. A filter field with no materialized column is
 * skipped with a warning.
 */
function planFilterIndexes(
	table: ConvexTable,
	pgTableName: string,
	columns: readonly PlannedColumn[],
	options: ResolvedOptions,
	warnings: string[],
	usedNames: Set<string>,
): PlannedIndex[] {
	const byConvexName = new Map(
		columns.map((column) => [column.convexName, column.pgName]),
	);
	const actualColumns = new Set(columns.map((column) => column.pgName));
	const indexes: PlannedIndex[] = [];
	const seenColumns = new Set<string>();

	const groups = [
		...table.searchIndexes.map((index) => ({
			owner: index.name,
			fields: index.filterFields,
		})),
		...table.vectorIndexes.map((index) => ({
			owner: index.name,
			fields: index.filterFields,
		})),
	];

	for (const group of groups) {
		for (const field of group.fields) {
			const resolved = indexColumnName(field, byConvexName, options);
			if (!actualColumns.has(resolved)) {
				warnings.push(
					`table "${table.name}": index "${group.owner}" filters on field "${field}", which is not a materialized column; skipped.`,
				);
				continue;
			}
			if (seenColumns.has(resolved)) continue;
			seenColumns.add(resolved);
			const name = `${pgTableName}_${resolved}`;
			if (usedNames.has(name)) continue;
			usedNames.add(name);
			indexes.push({ name, columns: [resolved], kind: "btree" });
		}
	}
	return indexes;
}

/**
 * Rename any user column whose Postgres name collides with an earlier column.
 * The synthesized `id` / `created_at` columns are added first, so a Convex field
 * literally named `id` or `created_at` (distinct from the system `_id` /
 * `_creationTime`) would otherwise emit a duplicate column and a `CREATE TABLE`
 * error. The value extraction (`selectExpr`, keyed on the original Convex field
 * name) is unaffected -- only the Postgres column name changes.
 */
function dedupeColumnNames(
	tableName: string,
	columns: PlannedColumn[],
	warnings: string[],
): void {
	const seen = new Set<string>();
	for (const column of columns) {
		if (!seen.has(column.pgName)) {
			seen.add(column.pgName);
			continue;
		}
		let suffix = 1;
		let candidate = `${column.pgName}_${suffix}`;
		while (seen.has(candidate)) {
			suffix += 1;
			candidate = `${column.pgName}_${suffix}`;
		}
		warnings.push(
			`table "${tableName}": column "${column.pgName}" collides with a synthesized or earlier column; renamed to "${candidate}".`,
		);
		column.pgName = candidate;
		seen.add(candidate);
	}
}

function idColumn(options: ResolvedOptions): PlannedColumn {
	const pgType = options.idStrategy === "uuid" ? "uuid" : "text";
	return {
		convexName: "_id",
		pgName: "id",
		pgType,
		notNull: true,
		isPrimaryKey: true,
		selectExpr:
			options.idStrategy === "uuid"
				? "md5(doc->>'_id')::uuid"
				: "doc->>'_id'",
	};
}

function creationTimeColumn(): PlannedColumn {
	return {
		convexName: "_creationTime",
		pgName: "created_at",
		pgType: "timestamptz",
		notNull: true,
		isPrimaryKey: false,
		// Convex stores a fractional-millisecond epoch; to_timestamp takes seconds.
		selectExpr:
			"to_timestamp((doc->>'_creationTime')::double precision / 1000)",
	};
}

function planIndexes(
	table: ConvexTable,
	pgTableName: string,
	columns: readonly PlannedColumn[],
	options: ResolvedOptions,
	warnings: string[],
): PlannedIndex[] {
	const byConvexName = new Map(
		columns.map((column) => [column.convexName, column.pgName]),
	);
	const actualColumns = new Set(columns.map((column) => column.pgName));
	const indexes: PlannedIndex[] = [];

	for (const index of table.indexes) {
		const nested = index.fields.find((field) => field.includes("."));
		if (nested !== undefined) {
			warnings.push(
				`table "${table.name}": index "${index.indexDescriptor}" references nested path "${nested}"; skipped (create an expression index manually).`,
			);
			continue;
		}
		const resolved = index.fields.map((field) =>
			indexColumnName(field, byConvexName, options),
		);
		// A schemaless table (union-as-table, `v.any()`, or `defineTable({})`)
		// keeps its fields inside the `doc jsonb` column, so an index declared on
		// one of those fields has no real column to target. Skip it rather than
		// emit a `CREATE INDEX` that references a column that was never created.
		const missing = index.fields.find(
			(_field, i) => !actualColumns.has(resolved[i]),
		);
		if (missing !== undefined) {
			warnings.push(
				`table "${table.name}": index "${index.indexDescriptor}" references field "${missing}", which is not a materialized column (the table has no declared shape for it); skipped.`,
			);
			continue;
		}
		indexes.push({
			name: `${pgTableName}_${index.indexDescriptor}`,
			columns: resolved,
			kind: "btree",
		});
	}

	return indexes;
}

function indexColumnName(
	field: string,
	byConvexName: ReadonlyMap<string, string>,
	options: ResolvedOptions,
): string {
	if (field === "_id") return "id";
	if (field === "_creationTime") return "created_at";
	return byConvexName.get(field) ?? toPgName(field, options.snakeCase);
}

function selectExprFor(
	kind: SelectKind,
	convexField: string,
	options: ResolvedOptions,
): string {
	const asText = jsonTextAccessor(convexField);
	switch (kind) {
		case "text":
			return asText;
		case "number":
			return `(${asText})::double precision`;
		case "boolean":
			return `(${asText})::boolean`;
		case "bigint":
			return `(${asText})::bigint`;
		case "bytes":
			return `decode(${jsonValueAccessor(convexField)}->>'$bytes', 'base64')`;
		case "json":
			return jsonValueAccessor(convexField);
		case "id":
			return options.idStrategy === "uuid"
				? `md5(${asText})::uuid`
				: asText;
		case "vector":
			// pgvector parses the jsonb array's text form (`[0.1, 0.2]`); a
			// missing/optional field yields NULL from the `->` accessor.
			return `(${jsonValueAccessor(convexField)})::text::vector`;
	}
}

/** A union that includes a `v.null()` member makes its column nullable. */
function isNullableUnion(validator: ConvexValidator): boolean {
	return (
		validator.type === "union" &&
		validator.value.some((member) => member.type === "null")
	);
}
