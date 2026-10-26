import type {
	ConvexColumn,
	ConvexSchema,
	ConvexTable,
	ConvexValidator,
	ExportedSchema,
	ExportedTable,
} from "./model.js";

/**
 * Parse the output of Convex's `SchemaDefinition.export()` into the internal
 * {@link ConvexSchema} model.
 *
 * `export()` returns a JSON **string** (verified against convex 1.47.0), so a
 * string input is `JSON.parse`d; an already-parsed object is accepted as-is.
 * This function is pure: it reads no files and no environment.
 */
export function parseExportedSchema(
	input: string | ExportedSchema,
): ConvexSchema {
	const raw: unknown = typeof input === "string" ? JSON.parse(input) : input;
	if (!isRecord(raw) || !Array.isArray(raw.tables)) {
		throw new Error(
			"Invalid Convex schema export: expected an object with a `tables` array.",
		);
	}

	const tables = raw.tables.map((table) => parseTable(table));
	return {
		tables,
		schemaValidation:
			typeof raw.schemaValidation === "boolean"
				? raw.schemaValidation
				: true,
	};
}

function parseTable(input: unknown): ConvexTable {
	if (!isRecord(input) || typeof input.tableName !== "string") {
		throw new Error(
			"Invalid Convex schema export: a table is missing a string `tableName`.",
		);
	}
	const table = input as unknown as ExportedTable;

	const documentType = table.documentType;
	const schemaless =
		!isRecord(documentType) ||
		documentType.type !== "object" ||
		!isRecord((documentType as { value?: unknown }).value) ||
		Object.keys((documentType as { value: Record<string, unknown> }).value)
			.length === 0;

	const columns: ConvexColumn[] = schemaless
		? []
		: parseColumns(
				documentType as Extract<ConvexValidator, { type: "object" }>,
			);

	return {
		name: table.tableName,
		columns,
		indexes: (table.indexes ?? []).map((index) => ({
			indexDescriptor: index.indexDescriptor,
			fields: [...index.fields],
		})),
		searchIndexes: (table.searchIndexes ?? []).map((index, i) => ({
			name: index.indexDescriptor ?? `search_${i}`,
			searchField: index.searchField ?? "",
			filterFields: [...(index.filterFields ?? [])],
		})),
		vectorIndexes: (table.vectorIndexes ?? []).map((index, i) => ({
			name: index.indexDescriptor ?? `vector_${i}`,
			vectorField: index.vectorField ?? "",
			dimensions:
				typeof index.dimensions === "number" ? index.dimensions : 0,
			filterFields: [...(index.filterFields ?? [])],
		})),
		schemaless,
	};
}

function parseColumns(
	documentType: Extract<ConvexValidator, { type: "object" }>,
): ConvexColumn[] {
	const columns: ConvexColumn[] = [];
	for (const [name, entry] of Object.entries(documentType.value)) {
		// Convex always includes `_id` / `_creationTime` implicitly; a hand-rolled
		// export should never carry them as declared fields, but drop them if seen
		// so they cannot collide with the synthesized `id` / `created_at` columns.
		if (name === "_id" || name === "_creationTime") continue;
		columns.push({
			name,
			validator: entry.fieldType,
			optional: entry.optional === true,
		});
	}
	return columns;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
