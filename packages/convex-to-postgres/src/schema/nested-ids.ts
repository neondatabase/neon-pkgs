import { quoteSqlString } from "../util/sql.js";
import type { ConvexValidator } from "./model.js";

/**
 * Rewrites the `v.id()` values nested inside a `jsonb` column under the uuid id
 * strategy, so an id in an array, object or record hashes to the same uuid as
 * the row it points at (`md5(id)::uuid`, stored as text inside the jsonb).
 *
 * The result is one SQL expression over the column's jsonb value, so the
 * conversion runs inside the transform's `INSERT ... SELECT`: set-based, in the
 * same transaction as the load. It dispatches on `jsonb_typeof`, so JSON nulls,
 * absent optional keys, and any value of an unexpected type pass through
 * unchanged, and array order and object keys are kept.
 */
export interface NestedIdPlan {
	/**
	 * Build the converting expression from the column's jsonb expression (e.g.
	 * `doc->'participants'`). `undefined` when the validator holds no id the
	 * tool can convert, in which case the value is copied as-is.
	 */
	convert?: (value: string) => string;
	/**
	 * One entry per position that holds ids the tool can't tell apart from other
	 * values, so they stay Convex id strings. Each is `[path, reason]`, where the
	 * path names the field (`races.results[].playerId`).
	 */
	unconvertible: Array<[path: string, reason: string]>;
}

/** Build the plan for a column whose validator maps to `jsonb`. Pure. */
export function planNestedIds(
	validator: ConvexValidator,
	path: string,
): NestedIdPlan {
	const unconvertible: Array<[string, string]> = [];
	const converter = converterFor([validator], path, unconvertible);
	return {
		convert:
			converter === undefined
				? undefined
				: (value) => converter(value, 0),
		unconvertible,
	};
}

/** `(jsonb expression, nesting depth) => converted jsonb expression`. */
type Converter = (value: string, depth: number) => string;

/** The JSON type a validator's values serialize to in a Convex export. */
type JsonKind = "string" | "number" | "boolean" | "null" | "array" | "object";

/** Whether a validator has a `v.id()` anywhere inside it. */
function containsId(validator: ConvexValidator): boolean {
	switch (validator.type) {
		case "id":
			return true;
		case "array":
			return containsId(validator.value);
		case "object":
			return Object.values(validator.value).some((entry) =>
				containsId(entry.fieldType),
			);
		case "record":
			return (
				(validator.keys !== undefined && containsId(validator.keys)) ||
				(recordValues(validator) !== undefined &&
					containsId(recordValues(validator) as ConvexValidator))
			);
		case "union":
			return validator.value.some(containsId);
		default:
			return false;
	}
}

/**
 * The JSON type of a non-union validator, or `undefined` for `v.any()` and any
 * validator type this module doesn't know (either could be anything).
 */
function jsonKind(validator: ConvexValidator): JsonKind | undefined {
	switch (validator.type) {
		case "string":
		case "id":
			return "string";
		case "number":
		case "bigint":
		case "commitTs":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return "array";
		case "object":
		case "record":
		case "bytes": // `{"$bytes": "<base64>"}`
			return "object";
		case "literal":
			if (validator.value === null) return "null";
			switch (typeof validator.value) {
				case "string":
					return "string";
				case "number":
					return "number";
				default:
					return "boolean";
			}
		default:
			return undefined;
	}
}

/** Flatten nested unions into their members. */
function flatten(validators: readonly ConvexValidator[]): ConvexValidator[] {
	return validators.flatMap((validator) =>
		validator.type === "union" ? flatten(validator.value) : [validator],
	);
}

/** A record's value validator, from `values: { fieldType, optional }`. */
function recordValues(
	validator: Extract<ConvexValidator, { type: "record" }>,
): ConvexValidator | undefined {
	const values = validator.values as
		| { fieldType?: ConvexValidator }
		| undefined;
	return values?.fieldType;
}

/**
 * The converter for a value that may be any of `validators` (one validator, a
 * union's members, or the validators one object key has across a union of
 * objects). Members are grouped by JSON type, so a union converts whenever its
 * id-holding members can be told apart from the rest by type alone.
 */
function converterFor(
	validators: readonly ConvexValidator[],
	path: string,
	unconvertible: Array<[string, string]>,
): Converter | undefined {
	const members = flatten(validators);
	if (!members.some(containsId)) return undefined;
	const untyped = [
		...new Set(
			members
				.filter((member) => jsonKind(member) === undefined)
				.map((member) => `v.${member.type}()`),
		),
	];
	if (untyped.length > 0) {
		unconvertible.push([
			path,
			`a union mixes v.id() with ${untyped.join(" and ")}`,
		]);
		return undefined;
	}
	const ofKind = (kind: JsonKind) =>
		members.filter((member) => jsonKind(member) === kind);

	const branches: Array<[JsonKind, Converter]> = [];

	const strings = ofKind("string");
	if (strings.some((member) => member.type === "id")) {
		// String literals are known values, so they can be told apart from ids
		// (`v.union(v.id("users"), v.literal("system"))`); a plain v.string()
		// can't.
		if (strings.some((member) => member.type === "string")) {
			unconvertible.push([
				path,
				"a union mixes v.id() with other strings",
			]);
		} else {
			const literals = strings.flatMap((member) =>
				member.type === "literal" ? [String(member.value)] : [],
			);
			branches.push([
				"string",
				literals.length === 0 ? hashId : hashIdExcept(literals),
			]);
		}
	}

	const arrays = ofKind("array") as Array<
		Extract<ConvexValidator, { type: "array" }>
	>;
	const element = converterFor(
		arrays.map((array) => array.value),
		`${path}[]`,
		unconvertible,
	);
	if (element !== undefined) branches.push(["array", mapArray(element)]);

	const object = objectConverter(ofKind("object"), path, unconvertible);
	if (object !== undefined) branches.push(["object", object]);

	if (branches.length === 0) return undefined;
	return (value, depth) =>
		`CASE jsonb_typeof(${value}) ${branches
			.map(
				([kind, convert]) =>
					`WHEN '${kind}' THEN ${convert(value, depth)}`,
			)
			.join(" ")} ELSE ${value} END`;
}

/**
 * The converter for the object-typed members of a union. `v.object`s merge key
 * by key name: a key's validators across every member that declares it are
 * treated as one union, so the key converts when those can be told apart by
 * JSON type or value. There is no dispatch on a discriminator field, so in
 * `union(object({ kind: "u", ref: v.id() }), object({ kind: "s", ref: v.string() }))`
 * `ref` can't be converted. `v.record`s apply their key and value validators to
 * every entry. `v.bytes` is an object too but holds no id.
 */
function objectConverter(
	members: readonly ConvexValidator[],
	path: string,
	unconvertible: Array<[string, string]>,
): Converter | undefined {
	const withIds = members.filter(containsId);
	if (withIds.length === 0) return undefined;
	const records = members.filter(
		(member): member is Extract<ConvexValidator, { type: "record" }> =>
			member.type === "record",
	);
	const objects = members.filter(
		(member): member is Extract<ConvexValidator, { type: "object" }> =>
			member.type === "object",
	);

	if (records.length > 0) {
		// A record rewrites every entry, so it can't share a union with any
		// other object-shaped member without rewriting that member's keys too.
		if (records.length !== members.length) {
			unconvertible.push([
				path,
				"a union mixes v.record() with another object type",
			]);
			return undefined;
		}
		return recordConverter(records, path, unconvertible);
	}

	const keys = [...new Set(objects.flatMap((o) => Object.keys(o.value)))]
		.sort()
		.flatMap((key): Array<[string, Converter]> => {
			const convert = converterFor(
				// Own keys only: an inherited name such as `constructor` must not
				// resolve to an Object.prototype member.
				objects.flatMap((o) =>
					Object.hasOwn(o.value, key) ? [o.value[key].fieldType] : [],
				),
				`${path}.${key}`,
				unconvertible,
			);
			return convert === undefined ? [] : [[key, convert]];
		});
	if (keys.length === 0) return undefined;
	return (value, depth) => {
		const f = `f${depth}`;
		const cases = keys
			.map(
				([key, convert]) =>
					`WHEN ${quoteSqlString(key)} THEN ${convert(`${f}.value`, depth + 1)}`,
			)
			.join(" ");
		return `(SELECT coalesce(jsonb_object_agg(${f}.key, CASE ${f}.key ${cases} ELSE ${f}.value END), '{}'::jsonb) FROM jsonb_each(${value}) AS ${f}(key, value))`;
	};
}

/**
 * Convert the entries of one or more records: values through their validators,
 * and keys too when the key validators are `v.id()`, optionally with string
 * literals that are left as they are (Convex allows ids as record keys, and a
 * key that names a row should name the new id).
 */
function recordConverter(
	records: ReadonlyArray<Extract<ConvexValidator, { type: "record" }>>,
	path: string,
	unconvertible: Array<[string, string]>,
): Converter | undefined {
	const keyValidators = flatten(
		records.flatMap((record) =>
			record.keys === undefined ? [] : [record.keys],
		),
	);
	let keyLiterals: string[] | undefined;
	if (keyValidators.some((key) => key.type === "id")) {
		if (
			keyValidators.every(
				(key) =>
					key.type === "id" ||
					(key.type === "literal" && typeof key.value === "string"),
			)
		) {
			keyLiterals = keyValidators.flatMap((key) =>
				key.type === "literal" ? [String(key.value)] : [],
			);
		} else {
			unconvertible.push([
				`${path} keys`,
				"the record's keys mix v.id() with other strings",
			]);
		}
	}
	const values = converterFor(
		records.flatMap((record) => {
			const value = recordValues(record);
			return value === undefined ? [] : [value];
		}),
		`${path}.*`,
		unconvertible,
	);
	if (keyLiterals === undefined && values === undefined) return undefined;
	return (value, depth) => {
		const f = `f${depth}`;
		const key =
			keyLiterals === undefined
				? `${f}.key`
				: hashIdTextExcept(`${f}.key`, keyLiterals);
		const entry =
			values === undefined
				? `${f}.value`
				: values(`${f}.value`, depth + 1);
		return `(SELECT coalesce(jsonb_object_agg(${key}, ${entry}), '{}'::jsonb) FROM jsonb_each(${value}) AS ${f}(key, value))`;
	};
}

/** A jsonb string holding a Convex id -> a jsonb string holding its uuid. */
const hashId: Converter = (value) =>
	`to_jsonb(md5(${value} #>> '{}')::uuid::text)`;

/** {@link hashId}, leaving the union's string literals as they are. */
function hashIdExcept(literals: readonly string[]): Converter {
	const list = literalList(literals);
	return (value, depth) =>
		`CASE WHEN ${value} #>> '{}' IN (${list}) THEN ${value} ELSE ${hashId(value, depth)} END`;
}

/**
 * A text expression holding a Convex id (a record key) -> its uuid as text,
 * leaving the given string literals as they are.
 */
function hashIdTextExcept(text: string, literals: readonly string[]): string {
	const hashed = `md5(${text})::uuid::text`;
	if (literals.length === 0) return hashed;
	return `CASE WHEN ${text} IN (${literalList(literals)}) THEN ${text} ELSE ${hashed} END`;
}

/** A deduplicated, quoted SQL list of string literals. */
function literalList(literals: readonly string[]): string {
	return [...new Set(literals)].map(quoteSqlString).join(", ");
}

/** Convert every element of a jsonb array, keeping its order. */
function mapArray(element: Converter): Converter {
	return (value, depth) => {
		const e = `e${depth}`;
		return `(SELECT coalesce(jsonb_agg(${element(`${e}.value`, depth + 1)} ORDER BY ${e}.ord), '[]'::jsonb) FROM jsonb_array_elements(${value}) WITH ORDINALITY AS ${e}(value, ord))`;
	};
}
