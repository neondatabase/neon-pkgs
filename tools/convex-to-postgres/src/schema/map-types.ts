import type { ResolvedOptions } from "../options.js";
import { toPgName } from "../util/names.js";
import type { ConvexValidator } from "./model.js";

/**
 * How a column's value is read out of the staged `doc jsonb`. `plan.ts` turns a
 * kind plus the original Convex field name into a concrete SQL expression.
 */
export type SelectKind =
	| "text" // doc->>'f'
	| "number" // (doc->>'f')::double precision
	| "boolean" // (doc->>'f')::boolean
	| "bigint" // (doc->>'f')::bigint
	| "bytes" // decode(doc->'f'->>'$bytes', 'base64')
	| "json" // doc->'f'
	| "id" // md5(doc->>'f')::uuid | doc->>'f'
	| "vector"; // (doc->'f')::text::vector

export interface MappedType {
	/** Postgres column type, e.g. `text`, `double precision`, `uuid`, `jsonb`. */
	pgType: string;
	/** How the value is extracted from the staged document. */
	selectKind: SelectKind;
	/**
	 * For a `v.id(...)` whose target table is part of the generated schema, the
	 * Postgres name of that table (a foreign key is emitted). Absent otherwise.
	 */
	references?: string;
	/** String-literal values for a `CHECK (col IN (...))` constraint. */
	checkIn?: string[];
	warnings: string[];
}

export interface MapContext {
	options: ResolvedOptions;
	/** Convex table names present in the generated schema (for FK resolution). */
	schemaTableNames: ReadonlySet<string>;
}

/**
 * Map a single Convex validator to its Postgres column type and extraction
 * strategy. Pure: depends only on the validator and the resolved options.
 */
export function mapValidator(
	validator: ConvexValidator,
	ctx: MapContext,
	fieldLabel: string,
): MappedType {
	switch (validator.type) {
		case "string":
			return { pgType: "text", selectKind: "text", warnings: [] };
		case "number":
			return {
				pgType: "double precision",
				selectKind: "number",
				warnings: [],
			};
		case "boolean":
			return { pgType: "boolean", selectKind: "boolean", warnings: [] };
		case "bigint":
			return { pgType: "bigint", selectKind: "bigint", warnings: [] };
		case "commitTs":
			// Convex's internal commit timestamp (`v.commitTs()`) is a 64-bit
			// value with no portable Postgres equivalent; store it as bigint.
			return {
				pgType: "bigint",
				selectKind: "bigint",
				warnings: [
					"v.commitTs() is an internal Convex commit timestamp with no portable Postgres type; approximating as bigint.",
				],
			};
		case "bytes":
			return { pgType: "bytea", selectKind: "bytes", warnings: [] };
		case "object":
		case "array":
		case "record":
		case "any":
		case "null":
			// Nested structure, free-form records, `any`, and `null` all land in a
			// single jsonb column: Postgres has no narrower portable type for them.
			return { pgType: "jsonb", selectKind: "json", warnings: [] };
		case "id":
			return mapId(validator, ctx);
		case "literal":
			return mapLiteral(validator.value);
		case "union":
			return mapUnion(validator.value, ctx, fieldLabel);
		default: {
			// An unrecognized validator type (a newer Convex feature than this
			// mapper knows). Degrade to jsonb with a warning rather than crash the
			// whole generation run.
			const unknownType = (validator as { type?: unknown }).type;
			return {
				pgType: "jsonb",
				selectKind: "json",
				warnings: [
					`unrecognized Convex validator type "${String(unknownType)}" for field "${fieldLabel}"; storing it as jsonb.`,
				],
			};
		}
	}
}

function mapId(
	validator: Extract<ConvexValidator, { type: "id" }>,
	ctx: MapContext,
): MappedType {
	const pgType = ctx.options.idStrategy === "uuid" ? "uuid" : "text";
	if (ctx.schemaTableNames.has(validator.tableName)) {
		return {
			pgType,
			selectKind: "id",
			references: toPgName(validator.tableName, ctx.options.snakeCase),
			warnings: [],
		};
	}
	// The reference points outside the generated schema (a Convex system table
	// like `_storage` / `_scheduled_functions`, or a table not exported). Keep
	// the column typed as an id, but emit no foreign key.
	return {
		pgType,
		selectKind: "id",
		warnings: [
			`reference to table "${validator.tableName}" is not part of the generated schema; emitting the column without a foreign key.`,
		],
	};
}

function mapLiteral(value: string | number | boolean | null): MappedType {
	switch (typeof value) {
		case "string":
			return { pgType: "text", selectKind: "text", warnings: [] };
		case "number":
			return {
				pgType: "double precision",
				selectKind: "number",
				warnings: [],
			};
		case "boolean":
			return { pgType: "boolean", selectKind: "boolean", warnings: [] };
		default:
			return { pgType: "jsonb", selectKind: "json", warnings: [] };
	}
}

function mapUnion(
	members: ConvexValidator[],
	ctx: MapContext,
	fieldLabel: string,
): MappedType {
	const hasNull = members.some((m) => m.type === "null");
	const nonNull = members.filter((m) => m.type !== "null");

	// A union with only `null` members is degenerate; fall back to jsonb.
	if (nonNull.length === 0) {
		return { pgType: "jsonb", selectKind: "json", warnings: [] };
	}

	// `v.union(v.null(), x)` is just a nullable `x`; nullability is applied by
	// the planner from the field's `optional` flag, so map on the sole member.
	if (nonNull.length === 1) {
		return mapValidator(nonNull[0], ctx, fieldLabel);
	}

	// Every member a literal of the same JS scalar type -> that scalar's type.
	const literals = nonNull.filter((m) => m.type === "literal") as Array<
		Extract<ConvexValidator, { type: "literal" }>
	>;
	if (literals.length === nonNull.length) {
		const scalarTypes = new Set(literals.map((m) => typeof m.value));
		if (scalarTypes.size === 1) {
			const scalar = [...scalarTypes][0];
			if (scalar === "string") {
				return {
					pgType: "text",
					selectKind: "text",
					checkIn: literals.map((m) => String(m.value)),
					warnings: [],
				};
			}
			if (scalar === "number") {
				return {
					pgType: "double precision",
					selectKind: "number",
					warnings: [],
				};
			}
			if (scalar === "boolean") {
				return {
					pgType: "boolean",
					selectKind: "boolean",
					warnings: [],
				};
			}
		}
	}

	// Mixed scalar types or non-literal members: no single column type fits, so
	// store the raw value as jsonb.
	return {
		pgType: "jsonb",
		selectKind: "json",
		warnings: [
			`field "${fieldLabel}" is a union of mixed or non-literal types${
				hasNull ? " (plus null)" : ""
			}; storing it as jsonb.`,
		],
	};
}
