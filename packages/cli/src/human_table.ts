import chalk from "chalk";
import { isObject } from "./utils/string.js";

const GUTTER = 2;
const MIN_COL = 3;
const ELLIPSIS = "...";
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export type HumanTableChunk = {
	data: unknown;
	fields: readonly string[];
	title?: string;
	emptyMessage?: string;
	renderColumns?: object;
	width?: number;
	colorTitle: boolean;
};

export function resolveOutputWidth(
	out: NodeJS.WritableStream,
	override: number | null | undefined,
	deps: {
		stdout?: NodeJS.WritableStream;
		envColumns?: string | undefined;
	} = {},
): number | undefined {
	if (override === null) {
		return undefined;
	}
	if (
		typeof override === "number" &&
		Number.isFinite(override) &&
		override > 0
	) {
		return Math.floor(override);
	}
	if ("columns" in out) {
		const columns = Reflect.get(out, "columns");
		if (
			typeof columns === "number" &&
			Number.isFinite(columns) &&
			columns > 0
		) {
			return Math.floor(columns);
		}
	}
	const stdout = deps.stdout;
	if (stdout !== undefined && out === stdout) {
		return parseColumns(deps.envColumns);
	}
	return undefined;
}

export function parseColumns(value: string | undefined): number | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}
	if (!/^\d+$/.test(value)) {
		return undefined;
	}
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) {
		return undefined;
	}
	return n;
}

export function displayWidth(s: string): number {
	const plain = s.replace(ANSI_RE, "");
	let width = 0;
	for (const char of plain) {
		const code = char.codePointAt(0);
		if (code === undefined) {
			continue;
		}
		width += charWidth(code);
	}
	return width;
}

export function formatHumanChunk(chunk: HumanTableChunk): string {
	const arrayData = Array.isArray(chunk.data) ? chunk.data : [chunk.data];
	const isList = Array.isArray(chunk.data);
	let out = "";
	if (chunk.title) {
		out += formatTitle(chunk.title, chunk.colorTitle) + "\n";
	}
	if (!arrayData.length && chunk.emptyMessage) {
		return `\n${chunk.emptyMessage}\n`;
	}
	if (!arrayData.length) {
		return out;
	}

	const fields = chunk.fields.filter((field) =>
		arrayData.some((item) => {
			const value = fieldValue(item, field);
			return value !== undefined && value !== "";
		}),
	);
	if (!fields.length) {
		return out;
	}

	const headers = fields.map(titleCaseField);
	const rows = arrayData.map((item) =>
		fields.map((field) => cellText(item, field, chunk.renderColumns)),
	);

	const body = isList
		? formatList(headers, rows, chunk.width)
		: formatStacked(headers, rows, chunk.width);
	if (body) {
		out += body + "\n";
	}
	return out;
}

function formatTitle(title: string, colorTitle: boolean): string {
	return colorTitle ? chalk.bold(title) : title;
}

function formatList(
	headers: string[],
	rows: string[][],
	width: number | undefined,
): string {
	if (headers.length === 1) {
		return formatOneColumn(
			headers[0] ?? "",
			rows.map((row) => row[0] ?? ""),
			width,
		);
	}
	if (width === undefined) {
		return formatColumns(headers, rows, naturalWidths(headers, rows));
	}
	for (let n = headers.length; n >= 2; n--) {
		const subsetHeaders = headers.slice(0, n);
		const subsetRows = rows.map((row) => row.slice(0, n));
		const widths = naturalWidths(subsetHeaders, subsetRows);
		if (rowWidth(widths) <= width) {
			return formatColumns(subsetHeaders, subsetRows, widths);
		}
	}
	const twoHeaders = headers.slice(0, 2);
	const twoRows = rows.map((row) => row.slice(0, 2));
	const fitted = tryFit(twoHeaders, twoRows, width);
	if (fitted === undefined) {
		return formatStacked(headers, rows, width);
	}
	return formatColumns(
		twoHeaders.map((cell, i) => truncateTo(cell, fitted[i] ?? 0)),
		twoRows.map((row) =>
			row.map((cell, i) => truncateTo(cell, fitted[i] ?? 0)),
		),
		fitted,
	);
}

function rowWidth(widths: number[]): number {
	if (widths.length === 0) {
		return 0;
	}
	return (
		widths.reduce((sum, col) => sum + col, 0) + (widths.length - 1) * GUTTER
	);
}

function formatOneColumn(
	header: string,
	values: string[],
	width: number | undefined,
): string {
	const clippedHeader =
		width === undefined ? header : truncateTo(header, width);
	const lines = [chalk.green(clippedHeader)];
	for (const value of values) {
		lines.push(width === undefined ? value : truncateTo(value, width));
	}
	return lines.join("\n");
}

function formatColumns(
	headers: string[],
	rows: string[][],
	widths: number[],
): string {
	const joinRow = (cells: string[]) =>
		cells
			.map((cell, i) => {
				const width = widths[i] ?? 0;
				return i === cells.length - 1
					? truncateTo(cell, width)
					: padEndWidth(cell, width);
			})
			.join(" ".repeat(GUTTER));
	const lines = [chalk.green(joinRow(headers))];
	for (const row of rows) {
		lines.push(joinRow(row));
	}
	return lines.join("\n");
}

function formatStacked(
	headers: string[],
	rows: string[][],
	width: number | undefined,
): string {
	const naturalLabel = Math.max(
		0,
		...headers.map((header) => displayWidth(header)),
	);
	let labelWidth = naturalLabel;
	if (width !== undefined) {
		const maxLabel = width - GUTTER - MIN_COL;
		labelWidth =
			maxLabel < 1
				? Math.min(naturalLabel, width)
				: Math.min(naturalLabel, maxLabel);
	}

	return rows
		.map((row) =>
			headers
				.map((header, i) =>
					stackedLine(header, row[i] ?? "", labelWidth, width),
				)
				.join("\n"),
		)
		.join("\n\n");
}

function stackedLine(
	header: string,
	value: string,
	labelWidth: number,
	width: number | undefined,
): string {
	const head = padEndWidth(header, labelWidth);
	if (width === undefined) {
		return `${head}${" ".repeat(GUTTER)}${value}`;
	}
	const valueBudget = width - displayWidth(head) - GUTTER;
	if (valueBudget > 0) {
		return `${head}${" ".repeat(GUTTER)}${truncateTo(value, valueBudget)}`;
	}
	return truncateTo(head, width);
}

function tryFit(
	headers: string[],
	rows: string[][],
	width: number,
): number[] | undefined {
	const n = headers.length;
	if (n === 0) {
		return [];
	}
	const gutters = (n - 1) * GUTTER;
	if (width <= gutters) {
		return undefined;
	}
	const budget = width - gutters;
	if (budget < n * MIN_COL) {
		return undefined;
	}
	const widths = naturalWidths(headers, rows);
	let overflow = widths.reduce((sum, col) => sum + col, 0) - budget;
	if (overflow <= 0) {
		return widths;
	}
	for (let i = n - 1; i >= 0 && overflow > 0; i--) {
		const current = widths[i] ?? 0;
		const take = Math.min(Math.max(current - MIN_COL, 0), overflow);
		widths[i] = current - take;
		overflow -= take;
	}
	if (overflow > 0) {
		return undefined;
	}
	return widths;
}

function naturalWidths(headers: string[], rows: string[][]): number[] {
	return headers.map((header, i) =>
		Math.max(
			displayWidth(header),
			...rows.map((row) => displayWidth(row[i] ?? "")),
		),
	);
}

function padEndWidth(s: string, width: number): string {
	const clipped = truncateTo(s, width);
	const pad = width - displayWidth(clipped);
	return pad > 0 ? clipped + " ".repeat(pad) : clipped;
}

function truncateTo(s: string, max: number): string {
	if (max <= 0) {
		return "";
	}
	if (displayWidth(s) <= max) {
		return s;
	}
	if (max <= ELLIPSIS.length) {
		return ELLIPSIS.slice(0, max);
	}
	const budget = max - ELLIPSIS.length;
	let out = "";
	let used = 0;
	for (const char of s.replace(ANSI_RE, "")) {
		const code = char.codePointAt(0);
		if (code === undefined) {
			continue;
		}
		const w = charWidth(code);
		if (used + w > budget) {
			break;
		}
		out += char;
		used += w;
	}
	return out + ELLIPSIS;
}

function cellText(
	item: unknown,
	field: string,
	renderColumns: object | undefined,
): string {
	if (renderColumns) {
		const render = Reflect.get(renderColumns, field);
		if (typeof render === "function") {
			return flattenCell(render(item));
		}
	}
	return flattenCell(fieldValue(item, field));
}

function fieldValue(item: unknown, field: string): unknown {
	if (item === null || typeof item !== "object") {
		return undefined;
	}
	return Reflect.get(item, field);
}

function flattenCell(value: unknown): string {
	if (value === undefined || value === null) {
		return "";
	}
	if (Array.isArray(value)) {
		return value.map((entry) => flattenCell(entry)).join(", ");
	}
	if (isObject(value)) {
		return JSON.stringify(value);
	}
	return String(value).replace(/\s+/g, " ").trim();
}

function titleCaseField(field: string): string {
	return field
		.split("_")
		.map((word) => (word ? word[0]?.toUpperCase() + word.slice(1) : word))
		.join(" ");
}

function charWidth(code: number): number {
	if (code >= 0x0300 && code <= 0x036f) {
		return 0;
	}
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		code === 0x2329 ||
		code === 0x232a ||
		(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x2fffd) ||
		(code >= 0x30000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}
