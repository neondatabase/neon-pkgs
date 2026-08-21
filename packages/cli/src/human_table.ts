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
	leadingBlank?: boolean;
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

export type ListLayoutMode = "one-column" | "full" | "shrink-last" | "stack";

export type ListLayoutPlan = {
	fields: readonly string[];
	dropped: readonly string[];
	mode: ListLayoutMode;
	headers: string[];
	rows: string[][];
	widths: number[];
};

function presentFields(
	data: readonly unknown[],
	fields: readonly string[],
): string[] {
	return fields.filter((field) =>
		data.some((item) => {
			const value = fieldValue(item, field);
			return value !== undefined && value !== "";
		}),
	);
}

export function planListLayout(input: {
	data: readonly unknown[];
	fields: readonly string[];
	width?: number;
	renderColumns?: object;
}): ListLayoutPlan | undefined {
	const fields = presentFields(input.data, input.fields);
	if (!fields.length) {
		return undefined;
	}
	const headers = fields.map(titleCaseField);
	const rows = input.data.map((item) =>
		fields.map((field) => cellText(item, field, input.renderColumns)),
	);
	return planColumns(fields, headers, rows, input.width);
}

export function formatHumanChunk(chunk: HumanTableChunk): string {
	const arrayData = Array.isArray(chunk.data) ? chunk.data : [chunk.data];
	const isList = Array.isArray(chunk.data);
	if (!arrayData.length && chunk.emptyMessage) {
		return `\n${chunk.emptyMessage}\n`;
	}
	let out = "";
	if (chunk.title) {
		if (chunk.leadingBlank) {
			out += "\n";
		}
		out += formatTitle(chunk.title, chunk.colorTitle) + "\n";
	}
	if (!arrayData.length) {
		return out;
	}

	if (isList) {
		const plan = planListLayout({
			data: arrayData,
			fields: chunk.fields,
			width: chunk.width,
			renderColumns: chunk.renderColumns,
		});
		if (plan) {
			out += formatFromPlan(plan, chunk.width) + "\n";
		}
		return out;
	}

	const fields = presentFields(arrayData, chunk.fields);
	if (!fields.length) {
		return out;
	}

	const headers = fields.map(titleCaseField);
	const rows = arrayData.map((item) =>
		fields.map((field) => cellText(item, field, chunk.renderColumns)),
	);
	const body = formatStacked(headers, rows, chunk.width);
	if (body) {
		out += body + "\n";
	}
	return out;
}

function formatTitle(title: string, colorTitle: boolean): string {
	return colorTitle ? chalk.bold(title) : title;
}

function planColumns(
	fields: readonly string[],
	headers: string[],
	rows: string[][],
	width: number | undefined,
): ListLayoutPlan {
	if (headers.length === 1) {
		return {
			fields,
			dropped: [],
			mode: "one-column",
			headers,
			rows,
			widths: naturalWidths(headers, rows),
		};
	}
	if (width === undefined) {
		return {
			fields,
			dropped: [],
			mode: "full",
			headers,
			rows,
			widths: naturalWidths(headers, rows),
		};
	}
	for (let n = headers.length; n >= 2; n--) {
		const subsetFields = fields.slice(0, n);
		const subsetHeaders = headers.slice(0, n);
		const subsetRows = rows.map((row) => row.slice(0, n));
		const natural = naturalWidths(subsetHeaders, subsetRows);
		const dropped = fields.slice(n);
		if (rowWidth(natural) <= width) {
			return {
				fields: subsetFields,
				dropped,
				mode: "full",
				headers: subsetHeaders,
				rows: subsetRows,
				widths: natural,
			};
		}
		const fitted = tryFit(subsetHeaders, subsetRows, width);
		if (fitted === undefined) {
			continue;
		}
		const onlyLastShrunk = natural
			.slice(0, n - 1)
			.every((col, i) => fitted[i] === col);
		if (!onlyLastShrunk) {
			continue;
		}
		return {
			fields: subsetFields,
			dropped,
			mode: "shrink-last",
			headers: subsetHeaders,
			rows: subsetRows,
			widths: fitted,
		};
	}
	return {
		fields,
		dropped: [],
		mode: "stack",
		headers,
		rows,
		widths: [],
	};
}

function formatFromPlan(
	plan: ListLayoutPlan,
	width: number | undefined,
): string {
	switch (plan.mode) {
		case "one-column":
			return formatOneColumn(
				plan.headers[0] ?? "",
				plan.rows.map((row) => row[0] ?? ""),
			);
		case "stack":
			return formatStacked(plan.headers, plan.rows, width);
		case "full":
		case "shrink-last":
			return formatColumns(
				plan.headers.map((cell, i) =>
					truncateTo(cell, plan.widths[i] ?? 0),
				),
				plan.rows.map((row) =>
					row.map((cell, i) => truncateTo(cell, plan.widths[i] ?? 0)),
				),
				plan.widths,
			);
	}
}

function rowWidth(widths: number[]): number {
	if (widths.length === 0) {
		return 0;
	}
	return (
		widths.reduce((sum, col) => sum + col, 0) + (widths.length - 1) * GUTTER
	);
}

function formatOneColumn(header: string, values: string[]): string {
	const lines = [chalk.green(header)];
	for (const value of values) {
		lines.push(value);
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
			.join(" ".repeat(GUTTER))
			.trimEnd();
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
					stackedLine(header, row[i] ?? "", labelWidth),
				)
				.join("\n"),
		)
		.join("\n\n");
}

function stackedLine(
	header: string,
	value: string,
	labelWidth: number,
): string {
	return `${padEndWidth(header, labelWidth)}${" ".repeat(GUTTER)}${value}`;
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

const WIDE_RANGES: readonly [number, number][] = [
	[0x1100, 0x115f],
	[0x231a, 0x231b],
	[0x2329, 0x232a],
	[0x23e9, 0x23ec],
	[0x23f0, 0x23f0],
	[0x23f3, 0x23f3],
	[0x25fd, 0x25fe],
	[0x2614, 0x2615],
	[0x2648, 0x2653],
	[0x267f, 0x267f],
	[0x2693, 0x2693],
	[0x26a1, 0x26a1],
	[0x26aa, 0x26ab],
	[0x26bd, 0x26be],
	[0x26c4, 0x26c5],
	[0x26ce, 0x26ce],
	[0x26d4, 0x26d4],
	[0x26ea, 0x26ea],
	[0x26f2, 0x26f3],
	[0x26f5, 0x26f5],
	[0x26fa, 0x26fa],
	[0x26fd, 0x26fd],
	[0x2705, 0x2705],
	[0x270a, 0x270b],
	[0x2728, 0x2728],
	[0x274c, 0x274c],
	[0x274e, 0x274e],
	[0x2753, 0x2755],
	[0x2757, 0x2757],
	[0x2795, 0x2797],
	[0x27b0, 0x27b0],
	[0x27bf, 0x27bf],
	[0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50],
	[0x2b55, 0x2b55],
	[0x2e80, 0x303e],
	[0x3040, 0xa4cf],
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3],
	[0xd7b0, 0xd7ff],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f000, 0x1faff],
	[0x20000, 0x2fffd],
	[0x30000, 0x3fffd],
];

function charWidth(code: number): number {
	if (code >= 0x0300 && code <= 0x036f) {
		return 0;
	}
	let lo = 0;
	let hi = WIDE_RANGES.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const range = WIDE_RANGES[mid];
		if (range === undefined) {
			break;
		}
		if (code < range[0]) {
			hi = mid - 1;
			continue;
		}
		if (code > range[1]) {
			lo = mid + 1;
			continue;
		}
		return 2;
	}
	return 1;
}
