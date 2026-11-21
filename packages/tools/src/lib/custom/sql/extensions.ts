import { NeonClientError } from "@neon/sdk";
import type { NeonQueryPromise } from "@neondatabase/serverless";
import { NeonToolCallerError } from "../../caller-error.js";
import type { sqlClient } from "./connection.js";

type SqlClient = ReturnType<typeof sqlClient>;

type ExtensionPrerequisite = {
	extension: string;
	/** Subject of the missing-extension error, such as `The "outliers" check`. */
	needs: string;
	databaseName: string;
};

const extensionSchema = async (
	sql: SqlClient,
	input: ExtensionPrerequisite,
): Promise<string> => {
	const [row] = await sql.query(
		`SELECT /* neon inspect */ n.nspname AS schema
		FROM pg_catalog.pg_extension e
		JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
		WHERE e.extname = $1`,
		[input.extension],
	);
	if (row === undefined) {
		throw new NeonToolCallerError(
			`${input.needs} needs the "${input.extension}" extension, which is not installed on database "${input.databaseName}". Installing it writes to the user's database, so ask the user first, then run \`CREATE EXTENSION IF NOT EXISTS ${input.extension};\`.`,
		);
	}
	const schema: unknown = row.schema;
	if (typeof schema !== "string") {
		throw new NeonClientError(
			`pg_extension returned no schema name for ${input.extension}.`,
		);
	}
	return schema;
};

/**
 * Runs `statement` in a READ ONLY transaction whose `search_path` is only the
 * extension's schema. Extensions can live in a schema that is not on the
 * role's path, and a user object on that path could otherwise shadow the
 * extension's; `pg_catalog` is always searched.
 */
export const readWithExtension = async (
	sql: SqlClient,
	input: ExtensionPrerequisite,
	statement: NeonQueryPromise<false, false>,
): Promise<Record<string, unknown>[]> => {
	const schema = await extensionSchema(sql, input);
	const [, rows] = await sql.transaction(
		[
			sql.query(
				"SELECT /* neon inspect */ pg_catalog.set_config('search_path', pg_catalog.quote_ident($1), true)",
				[schema],
			),
			statement,
		],
		{ readOnly: true },
	);
	return rows;
};
