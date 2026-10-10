/**
 * Validate that an adapter produced one PostgreSQL `SELECT` statement.
 *
 * This helper is intended for adapter authors. It performs the SDK's fast
 * syntactic checks; the Realtime proxy remains authoritative.
 *
 * @param sql - Parameterized SQL emitted by an adapter.
 * @throws If the SQL is not one supported `SELECT` statement.
 */
export function validateLiveSelectSql(sql: string): void {
	if (!/^\s*select\b/i.test(sql) || sql.includes(";")) {
		throw new Error("Live queries must compile to one SELECT statement");
	}
}
