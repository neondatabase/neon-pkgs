import type { WireCell, WireColumn } from "./protocol/messages.js";

const INT4_OID = 23;
const TEXT_OID = 25;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function validateColumns(columns: readonly WireColumn[]): void {
	if (columns.length === 0)
		throw new Error("Neon Live query has no result columns");
	const names = new Set<string>();
	for (const column of columns) {
		if (!column.name || names.has(column.name)) {
			throw new Error("Neon Live result columns must have unique names");
		}
		if (column.type_oid !== INT4_OID && column.type_oid !== TEXT_OID) {
			throw new Error(
				`Unsupported Neon Live PostgreSQL result type OID ${column.type_oid}`,
			);
		}
		names.add(column.name);
	}
}

export function decodeRow<Row>(
	values: readonly WireCell[],
	columns: readonly WireColumn[],
): Row {
	if (values.length !== columns.length) {
		throw new Error("Neon Live row does not match its result columns");
	}
	return Object.freeze(
		Object.fromEntries(
			values.map((cell, index) => {
				const column = columns[index];
				if (!column) {
					throw new Error(
						"Neon Live row does not match its result columns",
					);
				}
				return [column.name, decodeCell(cell, column)];
			}),
		),
	) as Row;
}

function decodeCell(
	cell: WireCell,
	column: WireColumn,
): string | number | null {
	if (cell === null) return null;

	if (column.codec === "bytes") {
		const bytes = decodeBinaryCell(cell);
		return column.type_oid === INT4_OID
			? decodeBinaryInt4(bytes)
			: decoder.decode(bytes);
	}

	const text = decodeTextCell(cell);
	return column.type_oid === INT4_OID ? decodeTextInt4(text) : text;
}

function decodeTextCell(cell: WireCell): string {
	if (typeof cell !== "string") {
		throw new Error("Neon Live received bytes for a text column");
	}
	return cell;
}

function decodeBinaryCell(cell: WireCell): Uint8Array {
	if (cell === null || typeof cell === "string") {
		throw new Error("Neon Live received text for a binary column");
	}
	const binary = atob(cell.base64);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeTextInt4(value: string): number {
	if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
		throw new Error("Invalid PostgreSQL int4 text value");
	}
	const parsed = Number(value);
	if (
		!Number.isInteger(parsed) ||
		parsed < -2_147_483_648 ||
		parsed > 2_147_483_647
	) {
		throw new Error("Invalid PostgreSQL int4 text value");
	}
	return parsed;
}

function decodeBinaryInt4(value: Uint8Array): number {
	if (value.length !== 4)
		throw new Error("Invalid PostgreSQL int4 binary value");
	return new DataView(
		value.buffer,
		value.byteOffset,
		value.byteLength,
	).getInt32(0);
}
