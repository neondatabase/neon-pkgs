/**
 * Quote a string as a Postgres string literal: wrap in single quotes and double
 * any embedded single quote. Relies on `standard_conforming_strings` (on by
 * default since Postgres 9.1), under which backslashes are literal, so a raw
 * JSONL line can be embedded safely as a `jsonb` literal with only quote
 * doubling.
 */
export function quoteSqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A `doc->>'field'` expression that reads a top-level JSON field as text. The
 * field name is quoted as a SQL string literal, so names with awkward
 * characters stay safe.
 */
export function jsonTextAccessor(field: string): string {
	return `doc->>${quoteSqlString(field)}`;
}

/**
 * A `doc->'field'` expression that reads a top-level JSON field as `jsonb`
 * (preserving nested structure).
 */
export function jsonValueAccessor(field: string): string {
	return `doc->${quoteSqlString(field)}`;
}
