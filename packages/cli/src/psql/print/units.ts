/**
 * Numeric, byte size, and duration formatting helpers.
 *
 * Mirrors psql's `\pset numericlocale`, the server-side
 * `pg_size_pretty()` output, and the `\timing` line format.
 */

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/** PostgreSQL `bool` type OID. Cells of this column type honour the
 * `\pset display_true` / `\pset display_false` strings (PG 19+). */
export const BOOLOID = 16;

/**
 * Boolean display strings for `\pset display_true` / `display_false`.
 * Defaults to psql's literal `'t'` / `'f'` when a printer is called with
 * a `topt` that predates the fields (older literal fixtures).
 */
export type BoolDisplay = { readonly true: string; readonly false: string };

/**
 * Extract the `\pset display_true`/`display_false` pair from a print-table
 * options object, defaulting to psql's `'t'`/`'f'`. Kept here so every
 * printer derives `boolDisplay` the same way.
 */
export const boolDisplayOf = (topt: {
	truePrint?: string;
	falsePrint?: string;
}): BoolDisplay => ({
	true: topt.truePrint ?? "t",
	false: topt.falsePrint ?? "f",
});

/**
 * Render a single result cell to its display string, shared by every
 * table-format printer (aligned/unaligned/csv/html/latex/troff/asciidoc).
 *
 * Boolean handling mirrors upstream print.c: a cell in a BOOLOID column
 * arriving over the wire as the text `'t'`/`'f'` (or a JS boolean, for
 * synthetic result sets) renders through `boolDisplay`, which carries the
 * `\pset display_true`/`display_false` values. `dataTypeID`/`boolDisplay`
 * are optional so existing callers that don't thread column type through
 * keep the prior behaviour (`'t'`/`'f'`).
 */
export const renderCellValue = (
	cell: unknown,
	nullPrint: string,
	numericLocale: boolean,
	dataTypeID?: number,
	boolDisplay?: BoolDisplay,
	locale?: string,
): string => {
	if (cell === null || cell === undefined) return nullPrint;
	const trueStr = boolDisplay?.true ?? "t";
	const falseStr = boolDisplay?.false ?? "f";
	// BOOLOID column: the text-format wire value is 't'/'f'. Map through the
	// configured display strings (upstream keys on the 't' first byte).
	if (dataTypeID === BOOLOID && typeof cell === "string") {
		if (cell === "t" || cell === "f") return cell === "t" ? trueStr : falseStr;
	}
	if (typeof cell === "string") {
		return formatNumericLocale(cell, numericLocale, locale);
	}
	if (typeof cell === "number" || typeof cell === "bigint") {
		return formatNumericLocale(cell.toString(), numericLocale, locale);
	}
	if (typeof cell === "boolean") return cell ? trueStr : falseStr;
	if (cell instanceof Date) return cell.toISOString();
	if (cell instanceof Uint8Array) {
		// Bytea -> hex escape, matching libpq's `\x` form.
		let hex = "\\x";
		for (const b of cell) hex += b.toString(16).padStart(2, "0");
		return hex;
	}
	return JSON.stringify(cell);
};

/**
 * Format a numeric string using locale-aware thousand separators and
 * decimal point. Equivalent to print.c `format_numeric_locale` but
 * implemented through the host's `Intl.NumberFormat`.
 *
 * When `useLocale` is false (the psql default) the input is returned
 * unchanged. Only operates on values whose stringified form matches
 * `^-?\d+(\.\d+)?$`; anything else (NaN, scientific notation, etc.) is
 * returned as-is so we never mangle non-numeric data passed via
 * `numericlocale`.
 */
export const formatNumericLocale = (
	value: string,
	useLocale: boolean,
	locale?: string,
): string => {
	if (!useLocale) return value;
	if (!NUMERIC_RE.test(value)) return value;

	const dotIdx = value.indexOf(".");
	const fractionDigits = dotIdx === -1 ? 0 : value.length - dotIdx - 1;

	// Use BigInt for the integer part to avoid float precision loss on
	// very large integers; format the fractional component as a separate
	// number so we keep the exact digit count the input had.
	const negative = value.startsWith("-");
	const unsigned = negative ? value.slice(1) : value;
	const [intPart, fracPart = ""] = unsigned.split(".");

	const intFormatted = new Intl.NumberFormat(locale, {
		useGrouping: true,
		maximumFractionDigits: 0,
	}).format(BigInt(intPart));

	if (fractionDigits === 0) {
		return negative ? `-${intFormatted}` : intFormatted;
	}

	// Discover this locale's decimal separator.
	const decimalSep =
		new Intl.NumberFormat(locale)
			.formatToParts(1.1)
			.find((p) => p.type === "decimal")?.value ?? ".";

	const out = `${intFormatted}${decimalSep}${fracPart}`;
	return negative ? `-${out}` : out;
};

type ByteUnit = { name: string; bits: number };

const BYTE_UNITS: ByteUnit[] = [
	{ name: "bytes", bits: 0 },
	{ name: "kB", bits: 10 },
	{ name: "MB", bits: 20 },
	{ name: "GB", bits: 30 },
	{ name: "TB", bits: 40 },
	{ name: "PB", bits: 50 },
];

const SI_UNITS: ByteUnit[] = [
	{ name: "B", bits: 0 },
	{ name: "kB", bits: 10 },
	{ name: "MB", bits: 20 },
	{ name: "GB", bits: 30 },
	{ name: "TB", bits: 40 },
	{ name: "PB", bits: 50 },
];

/**
 * Pretty-print a byte count.
 *
 * Follows pg's `pg_size_pretty` ladder: values under 10 240 use the
 * `bytes` unit, otherwise we promote until the magnitude is below
 * 20 * 1024 in the next unit and emit one decimal place.
 *
 * `opts.si` swaps the smallest unit name from `bytes` to `B`. (psql
 * itself does not have an SI flag, but we expose one because callers
 * outside the print path want a shorter `0 B` rendering.)
 */
export const formatByteSize = (
	bytes: number,
	opts?: { si?: boolean },
): string => {
	const units = opts?.si ? SI_UNITS : BYTE_UNITS;
	const sign = bytes < 0 ? "-" : "";
	let abs = Math.abs(bytes);

	// Bytes unit: render integer count.
	if (abs < 10 * 1024) {
		return `${sign}${abs.toString()} ${units[0].name}`;
	}

	// Promote until the value, scaled to the next unit, would be below
	// 20 * 1024. Mirrors the original loop's threshold check.
	let unitIndex = 1;
	abs = abs / 1024;
	while (unitIndex < units.length - 1 && abs >= 20 * 1024) {
		abs = abs / 1024;
		unitIndex++;
	}

	// One decimal place once we leave the `bytes` regime, matching the
	// `0 B`, `1.0 kB`, `1.5 MB` shape the WP spec calls out.
	return `${sign}${abs.toFixed(1)} ${units[unitIndex].name}`;
};

/**
 * Render a duration in the upstream `\timing` style. psql scales the
 * granularity to keep the line compact:
 *
 *   - `< 1 ms`     → `Time: 0.123 ms` (three decimal digits)
 *   - `< 1 s`      → `Time: 123.456 ms`
 *   - `< 1 min`    → `Time: 12.345 s`
 *   - `< 1 hour`   → `Time: 12 m 34.567 s`
 *   - `>= 1 hour`  → `Time: 1 h 23 m 45.678 s`
 *
 * Mirrors the `PrintTiming()` ladder in `src/bin/psql/common.c`. Negative
 * or non-finite inputs fall through the ladder as `0`.
 */
export const formatDurationMs = (ms: number): string => {
	return `Time: ${formatDurationBody(ms)}`;
};

/**
 * Format just the scaled-duration body (without the `Time: ` prefix) so
 * callers like the `\watch` header can reuse the same ladder without
 * dragging the prefix along.
 */
export const formatDurationBody = (ms: number): string => {
	const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
	// Under one second: render in milliseconds with three decimal places.
	if (safe < 1000) {
		return `${safe.toFixed(3)} ms`;
	}
	const totalSeconds = safe / 1000;
	// Under one minute: render in seconds with three decimal places.
	if (totalSeconds < 60) {
		return `${totalSeconds.toFixed(3)} s`;
	}
	// Under one hour: `M m SS.sss s`.
	const totalMinutes = Math.floor(totalSeconds / 60);
	const remainingSeconds = totalSeconds - totalMinutes * 60;
	if (totalMinutes < 60) {
		return `${String(totalMinutes)} m ${remainingSeconds.toFixed(3)} s`;
	}
	// One hour or more: `H h MM m SS.sss s`.
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes - hours * 60;
	return `${String(hours)} h ${String(minutes)} m ${remainingSeconds.toFixed(3)} s`;
};
