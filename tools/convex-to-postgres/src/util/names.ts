/**
 * A Postgres identifier that is safe to use unquoted: it starts with a lowercase
 * letter or underscore and contains only lowercase letters, digits, and
 * underscores. Anything else (camelCase, leading digit, punctuation) must be
 * double-quoted to survive Postgres' lowercasing of unquoted identifiers.
 */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Postgres fully-reserved keywords: words that match {@link SAFE_IDENT} yet still
 * cannot be used as an unquoted column or table name (`CREATE TABLE t (user text)`
 * is a syntax error). A Convex field named `user`, `null`, `union`, `order`, ...
 * is legal, so such names must be double-quoted even though they look safe. The
 * set is the "reserved" category from the Postgres keyword list; quoting a word
 * outside it is harmless, so erring toward a complete list costs nothing.
 */
const RESERVED_KEYWORDS: ReadonlySet<string> = new Set([
	"all",
	"analyse",
	"analyze",
	"and",
	"any",
	"array",
	"as",
	"asc",
	"asymmetric",
	"both",
	"case",
	"cast",
	"check",
	"collate",
	"column",
	"constraint",
	"create",
	"current_catalog",
	"current_date",
	"current_role",
	"current_time",
	"current_timestamp",
	"current_user",
	"default",
	"deferrable",
	"desc",
	"distinct",
	"do",
	"else",
	"end",
	"except",
	"false",
	"fetch",
	"for",
	"foreign",
	"from",
	"grant",
	"group",
	"having",
	"in",
	"initially",
	"intersect",
	"into",
	"lateral",
	"leading",
	"limit",
	"localtime",
	"localtimestamp",
	"not",
	"null",
	"offset",
	"on",
	"only",
	"or",
	"order",
	"placing",
	"primary",
	"references",
	"returning",
	"select",
	"session_user",
	"some",
	"symmetric",
	"system_user",
	"table",
	"then",
	"to",
	"trailing",
	"true",
	"union",
	"unique",
	"user",
	"using",
	"variadic",
	"when",
	"where",
	"window",
	"with",
]);

/**
 * Normalize a Convex name to a clean, unquoted-safe snake_case identifier.
 *
 * `authorId` -> `author_id`, `userProfiles` -> `user_profiles`,
 * `HTTPStatus` -> `http_status`. Already-snake names pass through unchanged.
 *
 * Beyond camelCase, every separator a Convex field name may carry — kebab
 * (`my-field`), dotted (`a.b`), spaced (`foo bar`) — is folded to a single
 * underscore so the result needs no quoting: `my-field` -> `my_field`,
 * `a.b` -> `a_b`, `foo bar` -> `foo_bar`. A leading digit, which Postgres
 * rejects for an unquoted identifier, is prefixed with `_`: `2fa` -> `_2fa`.
 */
export function toSnakeCase(name: string): string {
	const snake = name
		// Boundary between an acronym run and a following word: `HTTPStatus`
		// -> `HTTP_Status`.
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		// Boundary between a lowercase/digit and an uppercase letter:
		// `authorId` -> `author_Id`.
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		// Collapse every run of characters that are not a lowercase letter or
		// digit — punctuation, spaces, dots, dashes, repeated underscores — to
		// a single underscore.
		.replace(/[^a-z0-9]+/g, "_")
		// Trim the leading/trailing underscores a separator at either end leaves.
		.replace(/^_+|_+$/g, "");
	// Postgres rejects an unquoted identifier that starts with a digit.
	return /^[0-9]/.test(snake) ? `_${snake}` : snake;
}

/** Double-quote a Postgres identifier only when it is not already safe unquoted. */
export function quoteIdentIfNeeded(name: string): string {
	if (SAFE_IDENT.test(name) && !RESERVED_KEYWORDS.has(name)) return name;
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The Postgres identifier for a Convex field or table name under the given
 * casing option. Does not quote; call {@link quoteIdentIfNeeded} at emit time.
 */
export function toPgName(convexName: string, snakeCase: boolean): string {
	return snakeCase ? toSnakeCase(convexName) : convexName;
}
