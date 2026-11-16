import { NeonClientError } from "@neon/sdk";
import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../../ergonomic/bind.js";
import type { NeonToolAnnotations } from "../../operation.js";
import {
	branchIdField,
	databaseNameField,
	projectIdField,
	resolveConnection,
	SQL_METADATA,
	sqlClient,
} from "./connection.js";

export const sqlReadAnnotations: NeonToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

export const listTablesInputSchema = z.strictObject({
	project_id: projectIdField,
	branch_id: branchIdField,
	database_name: databaseNameField,
});

export const describeTableInputSchema = z.strictObject({
	table_name: z
		.string()
		.describe(
			"The table name, optionally schema-qualified (for example, crm.contacts)",
		),
	project_id: projectIdField,
	branch_id: branchIdField,
	database_name: databaseNameField,
});

const LIST_TABLES_SQL = `
	SELECT
		table_schema,
		table_name,
		table_type
	FROM information_schema.tables
	WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
	ORDER BY table_schema, table_name;
`;

// A name is read as a raw name the way schema.listTables returns it (User,
// Auth.User), which to_regclass would fold to lowercase, and as SQL through
// to_regclass, the only reading of a quoted name. More than one row means the
// readings name different tables. $1::text keeps Postgres from typing $1 as
// name, which truncates a qualified name longer than 63 bytes.
const RESOLVE_TABLE_SQL = `
	WITH candidates AS (
		SELECT oid
		FROM pg_catalog.pg_class
		WHERE relname = $1::text AND pg_catalog.pg_table_is_visible(oid)
		UNION
		SELECT cls.oid
		FROM pg_catalog.pg_class cls
		JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
		WHERE ns.nspname || '.' || cls.relname = $1
		UNION
		SELECT to_regclass($1)::oid
	)
	SELECT
		cls.oid::text AS oid,
		format('%I.%I', ns.nspname, cls.relname) AS quoted_name
	FROM candidates
	JOIN pg_catalog.pg_class cls ON cls.oid = candidates.oid
	JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
	ORDER BY quoted_name;
`;

// Derived from @neondatabase/psql-describe (https://github.com/neondatabase/psql-describe).
const DESCRIBE_COLUMNS_SQL = `
	WITH target AS (
		SELECT
			cls.oid,
			ns.nspname AS table_schema,
			cls.relname AS table_name
		FROM pg_catalog.pg_class cls
		JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
		WHERE cls.oid = $1::oid
	)
	SELECT
		c.column_name as name,
		c.data_type as type,
		c.is_nullable = 'YES' as nullable,
		c.column_default as default,
		pd.description
	FROM target t
	JOIN information_schema.columns c
		ON c.table_schema = t.table_schema
		AND c.table_name = t.table_name
	LEFT JOIN pg_catalog.pg_description pd
		ON pd.objoid = t.oid
		AND pd.objsubid = c.ordinal_position
	ORDER BY c.ordinal_position;
`;

const DESCRIBE_INDEXES_SQL = `
	SELECT
		i.relname as name,
		pg_get_indexdef(i.oid) as definition,
		pg_size_pretty(pg_relation_size(i.oid)) as size
	FROM pg_catalog.pg_class t
	JOIN pg_catalog.pg_index ix ON t.oid = ix.indrelid
	JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
	WHERE t.oid = $1::oid AND t.relkind = 'r';
`;

// information_schema.table_constraints hides constraints from a role that
// only has SELECT on the table, and never lists EXCLUDE. Postgres 18 adds
// NOT NULL rows (contype n), which the columns already show.
const DESCRIBE_CONSTRAINTS_SQL = `
	SELECT
		conname as name,
		CASE contype
			WHEN 'p' THEN 'PRIMARY KEY'
			WHEN 'f' THEN 'FOREIGN KEY'
			WHEN 'u' THEN 'UNIQUE'
			WHEN 'c' THEN 'CHECK'
			WHEN 'x' THEN 'EXCLUDE'
		END as type,
		pg_get_constraintdef(oid) as definition
	FROM pg_catalog.pg_constraint
	WHERE conrelid = $1::oid AND contype IN ('p', 'f', 'u', 'c', 'x')
	ORDER BY conname;
`;

const DESCRIBE_SIZES_SQL = `
	SELECT
		pg_size_pretty(pg_total_relation_size($1::oid)) as total_size,
		pg_size_pretty(pg_relation_size($1::oid)) as table_size,
		pg_size_pretty(
			pg_total_relation_size($1::oid) - pg_relation_size($1::oid)
		) as index_size;
`;

interface ColumnDescription {
	name: string;
	type: string;
	nullable: boolean;
	default: string | null;
	description: string | null;
}

interface IndexDescription {
	name: string;
	definition: string;
	size: string;
}

interface ConstraintDescription {
	name: string;
	type: string;
	definition: string;
}

export interface TableDescription {
	columns: ColumnDescription[];
	indexes: IndexDescription[];
	constraints: ConstraintDescription[];
	tableSize: string;
	indexSize: string;
	totalSize: string;
}

const describeTable = async (
	uri: string,
	tableName: string,
	signal?: AbortSignal,
): Promise<TableDescription | null> => {
	const sql = sqlClient(uri, signal);
	const candidates = await sql.query(RESOLVE_TABLE_SQL, [tableName]);
	const [table, ...others] = candidates;
	if (table === undefined) return null;
	if (others.length > 0) {
		throw new NeonClientError(
			`Table name ${tableName} matches ${candidates.length} tables. Pass one of these quoted names: ${candidates.map((candidate) => candidate.quoted_name).join(", ")}`,
		);
	}

	const [columns, indexes, constraints, sizes] = await Promise.all([
		sql.query(DESCRIBE_COLUMNS_SQL, [table.oid]),
		sql.query(DESCRIBE_INDEXES_SQL, [table.oid]),
		sql.query(DESCRIBE_CONSTRAINTS_SQL, [table.oid]),
		sql.query(DESCRIBE_SIZES_SQL, [table.oid]),
	]);
	const size = sizes[0];
	if (size === undefined) {
		throw new Error(`Table size query returned no row for ${tableName}`);
	}
	return {
		columns: columns.map((column) => ({
			name: column.name,
			type: column.type,
			nullable: column.nullable,
			default: column.default,
			description: column.description,
		})),
		indexes: indexes.map((index) => ({
			name: index.name,
			definition: index.definition,
			size: index.size,
		})),
		constraints: constraints.map((constraint) => ({
			name: constraint.name,
			type: constraint.type,
			definition: constraint.definition,
		})),
		tableSize: size.table_size,
		indexSize: size.index_size,
		totalSize: size.total_size,
	};
};

export const formatTableDescription = (desc: TableDescription): string => {
	const lines: string[] = [
		`Table size: ${desc.tableSize}`,
		`Index size: ${desc.indexSize}`,
		`Total size: ${desc.totalSize}`,
		"",
		"Columns:",
	];
	for (const column of desc.columns) {
		const nullable = column.nullable ? "NULL" : "NOT NULL";
		const defaultValue = column.default ? ` DEFAULT ${column.default}` : "";
		const description = column.description
			? `\n    ${column.description}`
			: "";
		lines.push(
			`  ${column.name} ${column.type} ${nullable}${defaultValue}${description}`,
		);
	}
	lines.push("");
	if (desc.indexes.length > 0) {
		lines.push("Indexes:");
		for (const index of desc.indexes) {
			lines.push(`  ${index.name} (${index.size})`);
			lines.push(`    ${index.definition}`);
		}
		lines.push("");
	}
	if (desc.constraints.length > 0) {
		lines.push("Constraints:");
		for (const constraint of desc.constraints) {
			lines.push(`  ${constraint.name} (${constraint.type})`);
			lines.push(`    ${constraint.definition}`);
		}
	}
	return lines.join("\n");
};

export const describeTableAt = async (
	uri: string,
	tableName: string,
	signal?: AbortSignal,
) => {
	const description = await describeTable(uri, tableName, signal);
	if (description === null) {
		throw new NeonClientError(`Table not found: ${tableName}`);
	}
	return {
		raw: description,
		formatted: formatTableDescription(description),
	};
};

export const listTablesTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "schema.listTables",
			id: publishedId("schema.listTables"),
			title: "Get Database Tables",
			description:
				"Lists a database's tables and views outside the system schemas. For one table's columns, use {{schema.describeTable}}.",
			inputSchema: listTablesInputSchema,
			annotations: sqlReadAnnotations,
			requiresApproval: false,
			metadata: SQL_METADATA,
		},
		async (neonClient, input, signal, context) => {
			const connection = await resolveConnection(
				neonClient,
				input,
				context,
				signal,
			);
			return sqlClient(connection.uri, signal).query(LIST_TABLES_SQL);
		},
	);

export const describeTableTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "schema.describeTable",
			id: publishedId("schema.describeTable"),
			title: "Describe Table Schema",
			description:
				"Returns a table's columns, indexes, constraints, and sizes. For every table, use {{schema.listTables}}.",
			inputSchema: describeTableInputSchema,
			annotations: sqlReadAnnotations,
			requiresApproval: false,
			metadata: SQL_METADATA,
		},
		async (neonClient, input, signal, context) => {
			const connection = await resolveConnection(
				neonClient,
				input,
				context,
				signal,
			);
			return describeTableAt(connection.uri, input.table_name, signal);
		},
	);
