// Hand-authored builders for `SchemaDefinition.export()` fixtures, matching the
// shapes verified against convex 1.47.0. Used only by unit tests; excluded from
// the build and from coverage.

import type {
	ConvexFieldEntry,
	ConvexIndexDef,
	ConvexValidator,
	ExportedSchema,
	ExportedTable,
} from "./schema/model.js";

/** Convex validator builders, named like `convex/values`'s `v`. */
export const v = {
	string: (): ConvexValidator => ({ type: "string" }),
	number: (): ConvexValidator => ({ type: "number" }),
	boolean: (): ConvexValidator => ({ type: "boolean" }),
	/** `v.int64()` serializes with type name `bigint`. */
	int64: (): ConvexValidator => ({ type: "bigint" }),
	bytes: (): ConvexValidator => ({ type: "bytes" }),
	null: (): ConvexValidator => ({ type: "null" }),
	any: (): ConvexValidator => ({ type: "any" }),
	id: (tableName: string): ConvexValidator => ({ type: "id", tableName }),
	array: (value: ConvexValidator): ConvexValidator => ({
		type: "array",
		value,
	}),
	object: (value: Record<string, ConvexFieldEntry>): ConvexValidator => ({
		type: "object",
		value,
	}),
	record: (): ConvexValidator => ({ type: "record" }),
	/** `v.commitTs()` serializes with type name `commitTs`. */
	commitTs: (): ConvexValidator => ({ type: "commitTs" }),
	union: (...members: ConvexValidator[]): ConvexValidator => ({
		type: "union",
		value: members,
	}),
	literal: (value: string | number | boolean | null): ConvexValidator => ({
		type: "literal",
		value,
	}),
};

/** A field entry: a validator plus whether it is optional. */
export function field(
	fieldType: ConvexValidator,
	optional = false,
): ConvexFieldEntry {
	return { fieldType, optional };
}

export interface TableSpec {
	name: string;
	fields?: Record<string, ConvexFieldEntry>;
	indexes?: ConvexIndexDef[];
	searchIndexes?: Array<{
		indexDescriptor?: string;
		searchField?: string;
		filterFields?: string[];
	}>;
	vectorIndexes?: Array<{
		indexDescriptor?: string;
		vectorField?: string;
		dimensions?: number;
		filterFields?: string[];
	}>;
	/** Override the document validator (e.g. `v.any()` for a schemaless table). */
	documentType?: ConvexValidator;
}

export function table(spec: TableSpec): ExportedTable {
	return {
		tableName: spec.name,
		indexes: spec.indexes ?? [],
		searchIndexes: spec.searchIndexes,
		vectorIndexes: spec.vectorIndexes,
		documentType: spec.documentType ?? v.object(spec.fields ?? {}),
	};
}

export function schema(
	tables: ExportedTable[],
	schemaValidation = true,
): ExportedSchema {
	return { tables, schemaValidation };
}
