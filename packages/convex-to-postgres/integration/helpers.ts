import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { inject } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to `integration/fixtures`. */
export const FIXTURES = join(HERE, "fixtures");

let schemaCounter = 0;

/**
 * Connect a fresh `pg.Client` to the shared container, create a brand-new
 * Postgres schema namespace, and point the session's `search_path` at it. Every
 * fixture applies its unqualified DDL into its own namespace so same-named
 * tables (many corpus schemas declare `messages`) never collide. Returns the
 * client, the namespace name, and a `cleanup` that drops the schema and closes
 * the connection.
 */
export async function freshSchemaClient(label: string): Promise<{
	client: pg.Client;
	schema: string;
	cleanup: () => Promise<void>;
}> {
	const client = new pg.Client({
		connectionString: inject("pgConnectionUri"),
	});
	await client.connect();
	schemaCounter += 1;
	const schema = `s_${sanitize(label)}_${schemaCounter}`;
	await client.query(`CREATE SCHEMA ${quote(schema)}`);
	await client.query(`SET search_path TO ${quote(schema)}`);
	return {
		client,
		schema,
		cleanup: async () => {
			try {
				await client.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
			} finally {
				await client.end();
			}
		},
	};
}

/** Count the non-empty JSONL lines in an exported table's `documents.jsonl`. */
export function countJsonlLines(path: string): number {
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0).length;
}

/**
 * Map a Postgres column type as the generator emits it to the `data_type`
 * string Postgres reports in `information_schema.columns`.
 */
export function infoSchemaType(pgType: string): string {
	switch (pgType) {
		case "timestamptz":
			return "timestamp with time zone";
		default:
			return pgType;
	}
}

function sanitize(label: string): string {
	return label
		.replace(/[^a-z0-9]+/gi, "_")
		.toLowerCase()
		.slice(0, 40);
}

function quote(ident: string): string {
	return `"${ident.replace(/"/g, '""')}"`;
}
