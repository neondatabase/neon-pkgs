import { NeonClientError } from "../errors.js";

/**
 * What a role created by `roles.create` may do. `admin` is the Neon API's own role
 * creation: the role joins `neon_superuser`. The other two are created with SQL as the
 * database owner and get only the grants {@link roleAccessStatements} lists.
 */
export type RoleAccess = "admin" | "read_only" | "read_write";

export type ScopedRoleAccess = Exclude<RoleAccess, "admin">;

const ROLE_ACCESS: readonly RoleAccess[] = ["admin", "read_only", "read_write"];

/** Postgres truncates longer identifiers silently, so a longer name would create a different role. */
const MAX_IDENTIFIER_BYTES = 63;

export interface ScopedRoleInput {
	access: ScopedRoleAccess;
	databaseName?: string;
	schemas: readonly string[];
}

/**
 * Validate the access fields of a `roles.create` call. Returns the scoped input for
 * `read_only` / `read_write`, `undefined` for `admin`, or the validation error.
 */
export function parseRoleAccess(params: {
	name?: unknown;
	access?: unknown;
	databaseName?: unknown;
	schemas?: unknown;
}): ScopedRoleInput | NeonClientError | undefined {
	const { access, databaseName, schemas } = params;
	if (access !== undefined && !isRoleAccess(access)) {
		return new NeonClientError(
			`roles.create access must be one of ${ROLE_ACCESS.join(", ")}; received ${String(access)}.`,
		);
	}
	if (access === undefined || access === "admin") {
		if (databaseName !== undefined || schemas !== undefined) {
			return new NeonClientError(
				"roles.create databaseName and schemas apply only to access read_only or read_write. An admin role joins neon_superuser and is not scoped to a database or schema.",
			);
		}
		return undefined;
	}
	if (typeof params.name !== "string" || params.name === "") {
		return new NeonClientError("roles.create requires a non-empty name.");
	}
	const tooLong = identifierTooLong("name", params.name);
	if (tooLong) return tooLong;
	if (databaseName !== undefined) {
		if (typeof databaseName !== "string" || databaseName === "") {
			return new NeonClientError(
				"roles.create databaseName must be a non-empty string.",
			);
		}
		const dbTooLong = identifierTooLong("databaseName", databaseName);
		if (dbTooLong) return dbTooLong;
	}
	const resolvedSchemas = schemas ?? ["public"];
	if (
		!Array.isArray(resolvedSchemas) ||
		resolvedSchemas.length === 0 ||
		!resolvedSchemas.every(
			(schema): schema is string =>
				typeof schema === "string" && schema !== "",
		)
	) {
		return new NeonClientError(
			"roles.create schemas must be a non-empty array of schema names.",
		);
	}
	for (const schema of resolvedSchemas) {
		const schemaTooLong = identifierTooLong("schema", schema);
		if (schemaTooLong) return schemaTooLong;
	}
	return {
		access,
		...(databaseName === undefined ? {} : { databaseName }),
		schemas: resolvedSchemas,
	};
}

function isRoleAccess(value: unknown): value is RoleAccess {
	return ROLE_ACCESS.some((access) => access === value);
}

function identifierTooLong(
	field: string,
	value: string,
): NeonClientError | undefined {
	const bytes = new TextEncoder().encode(value).length;
	if (bytes <= MAX_IDENTIFIER_BYTES) return undefined;
	return new NeonClientError(
		`roles.create ${field} "${value}" is ${bytes} bytes; Postgres identifiers are at most ${MAX_IDENTIFIER_BYTES} bytes.`,
	);
}

export function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

const TABLE_PRIVILEGES: Record<ScopedRoleAccess, string> = {
	read_only: "SELECT",
	read_write: "SELECT, INSERT, UPDATE, DELETE",
};

/**
 * The SQL that creates a scoped role, run in one transaction as the database owner.
 * Default privileges are `FOR ROLE <owner>`: they cover tables the owner creates later,
 * not tables other roles own.
 *
 * The role is created `NOLOGIN` either way. The API refuses to reset the password of a
 * role that has none, so a login role gets `bootstrapPassword`, which statement logging
 * may record; {@link enableLoginStatement} runs only after Neon has replaced it. It must
 * contain no quote characters, because `CREATE ROLE` cannot take a bind parameter.
 */
export function roleAccessStatements(input: {
	name: string;
	databaseName: string;
	ownerName: string;
	access: ScopedRoleAccess;
	schemas: readonly string[];
	bootstrapPassword: string | undefined;
}): string[] {
	const role = quoteIdentifier(input.name);
	const owner = quoteIdentifier(input.ownerName);
	if (
		input.bootstrapPassword !== undefined &&
		!/^[A-Za-z0-9]+$/.test(input.bootstrapPassword)
	) {
		throw new NeonClientError(
			"Internal: a bootstrap password must be alphanumeric.",
		);
	}
	const statements = [
		input.bootstrapPassword === undefined
			? `CREATE ROLE ${role} NOLOGIN`
			: `CREATE ROLE ${role} NOLOGIN PASSWORD '${input.bootstrapPassword}'`,
		`GRANT CONNECT ON DATABASE ${quoteIdentifier(input.databaseName)} TO ${role}`,
	];
	const tables = TABLE_PRIVILEGES[input.access];
	for (const name of input.schemas) {
		const schema = quoteIdentifier(name);
		statements.push(
			`GRANT USAGE ON SCHEMA ${schema} TO ${role}`,
			`GRANT ${tables} ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT ${tables} ON TABLES TO ${role}`,
		);
		if (input.access === "read_write") {
			statements.push(
				`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
				`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
			);
		}
	}
	return statements;
}

export function enableLoginStatement(name: string): string {
	return `ALTER ROLE ${quoteIdentifier(name)} LOGIN`;
}

/** 32 random bytes as hex: alphanumeric, so it is safe inside a SQL string literal. */
export function bootstrapPassword(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}
