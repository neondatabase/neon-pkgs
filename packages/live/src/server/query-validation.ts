/**
 * Validate that an adapter produced one supported PostgreSQL `SELECT`.
 *
 * This helper is intended for adapter authors. It performs the SDK's fast
 * syntactic checks; the Neon Live proxy remains authoritative.
 *
 * @param sql - Parameterized SQL emitted by an adapter.
 * @throws If the SQL is not one supported `SELECT` statement.
 */
export function validateLiveSelectSql(sql: string): void {
	if (!/^\s*select\b/i.test(sql) || sql.includes(";")) {
		throw new Error(
			"Neon Live queries must compile to one SELECT statement",
		);
	}
	const unsupportedClause =
		/\b(?:distinct|group\s+by|having|union|intersect|except|with)\b/i;
	const unsupportedJoin = /\b(?:cross\s+join|join\s+lateral)\b/i;
	if (unsupportedClause.test(sql) || unsupportedJoin.test(sql)) {
		throw new Error("Neon Live query uses an unsupported SQL feature");
	}
}
