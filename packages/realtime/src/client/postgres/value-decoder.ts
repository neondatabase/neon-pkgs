import { ProtocolError } from "../protocol/codec.js";
import type { WireCell, WireColumn } from "../protocol/messages.js";
import type { RealtimeRowMode } from "../types.js";
import { pgTypeOids } from "./oids.js";
import type { PostgreSQLParserRegistry } from "./parsers.js";

/** A value parser failed for one subscription result column. */
export class PostgresValueParserError extends Error {
	readonly columnName: string;
	readonly oid: number;

	constructor(column: WireColumn, cause: unknown) {
		super(
			`Realtime could not parse result column ${JSON.stringify(column.name)} (PostgreSQL type OID ${column.type_oid})`,
			{ cause },
		);
		this.name = "PostgresValueParserError";
		this.columnName = column.name;
		this.oid = column.type_oid;
	}
}

export function validateColumns(
	columns: readonly WireColumn[],
	rowMode: RealtimeRowMode,
): void {
	if (columns.length === 0) {
		throw new ProtocolError("Live query has no result columns");
	}
	const names = new Set<string>();
	for (const column of columns) {
		if (!column.name || (rowMode === "object" && names.has(column.name))) {
			throw new ProtocolError(
				rowMode === "object"
					? "Realtime object rows require unique result column names"
					: "Realtime result columns must have names",
			);
		}
		const requiredCodec =
			column.type_oid === pgTypeOids.bytea ? "bytes" : "pg_text";
		if (column.codec !== requiredCodec) {
			throw new ProtocolError(
				`PostgreSQL type OID ${column.type_oid} requires the ${requiredCodec} codec`,
			);
		}
		names.add(column.name);
	}
}

export function decodeRow<Row>(
	values: readonly WireCell[],
	columns: readonly WireColumn[],
	parsers: PostgreSQLParserRegistry,
	rowMode: RealtimeRowMode,
): Row {
	if (values.length !== columns.length) {
		throw new ProtocolError(
			"Realtime row does not match its result columns",
		);
	}
	if (rowMode === "array") {
		return Object.freeze(
			values.map((cell, index) =>
				decodeCell(cell, requireColumn(columns, index), parsers),
			),
		) as Row;
	}
	return Object.freeze(
		Object.fromEntries(
			values.map((cell, index) => {
				const column = requireColumn(columns, index);
				return [column.name, decodeCell(cell, column, parsers)];
			}),
		),
	) as Row;
}

function requireColumn(
	columns: readonly WireColumn[],
	index: number,
): WireColumn {
	const column = columns[index];
	if (!column) {
		throw new ProtocolError(
			"Realtime row does not match its result columns",
		);
	}
	return column;
}

function decodeCell(
	cell: WireCell,
	column: WireColumn,
	parsers: PostgreSQLParserRegistry,
): unknown {
	if (cell === null) return null;
	let input: string | Uint8Array;
	if (column.codec === "pg_text") {
		if (typeof cell !== "string") {
			throw new ProtocolError(
				"Realtime received bytes for a text column",
			);
		}
		input = cell;
	} else {
		if (typeof cell === "string") {
			throw new ProtocolError(
				"Realtime received text for a binary column",
			);
		}
		try {
			const binary = atob(cell.base64);
			input = Uint8Array.from(binary, (character) =>
				character.charCodeAt(0),
			);
		} catch (cause) {
			throw new ProtocolError(
				cause instanceof Error
					? cause.message
					: "Invalid base64 result value",
			);
		}
	}

	try {
		return parsers.parse(column.type_oid, input);
	} catch (cause) {
		throw new PostgresValueParserError(column, cause);
	}
}
