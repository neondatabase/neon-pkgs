const DATE_PATTERN = /^(\d{4,})-(\d{2})-(\d{2})(?:\s+(BC))?$/;
const TIMESTAMP_PATTERN =
	/^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:\s+(BC))?$/;
const TIMESTAMPTZ_PATTERN =
	/^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?(?:\s+(BC))?$/;

/** Parse PostgreSQL `date` with node-postgres-compatible local-time semantics. */
export function parsePostgresDate(value: string): Date | number {
	const infinity = parseInfinity(value);
	if (infinity !== undefined) return infinity;
	const match = DATE_PATTERN.exec(value);
	if (!match) throw new Error("Invalid PostgreSQL date value");
	return localDate({
		year: match[4] === "BC" ? 1 - Number(match[1]) : Number(match[1]),
		month: Number(match[2]) - 1,
		day: Number(match[3]),
		hour: 0,
		minute: 0,
		second: 0,
		millisecond: 0,
	});
}

/** Parse PostgreSQL `timestamp` with node-postgres-compatible local-time semantics. */
export function parsePostgresTimestamp(value: string): Date | number {
	const infinity = parseInfinity(value);
	if (infinity !== undefined) return infinity;
	const match = TIMESTAMP_PATTERN.exec(value);
	if (!match) throw new Error("Invalid PostgreSQL timestamp value");
	return localDate(parts(match));
}

/** Parse PostgreSQL `timestamptz` as an absolute JavaScript instant. */
export function parsePostgresTimestampWithTimeZone(
	value: string,
): Date | number {
	const infinity = parseInfinity(value);
	if (infinity !== undefined) return infinity;
	const match = TIMESTAMPTZ_PATTERN.exec(value);
	if (!match) throw new Error("Invalid PostgreSQL timestamptz value");
	const parsed = parts(match);
	assertDateParts(parsed, "timestamptz");
	const sign = match[8] === "+" ? 1 : -1;
	const offsetHours = Number(match[9]);
	const offsetMinutes = Number(match[10] ?? 0);
	const offsetRemainderSeconds = Number(match[11] ?? 0);
	if (offsetHours > 15 || offsetMinutes > 59 || offsetRemainderSeconds > 59) {
		throw new Error("Invalid PostgreSQL timestamptz offset");
	}
	const offsetSeconds =
		(offsetHours * 60 * 60 + offsetMinutes * 60 + offsetRemainderSeconds) *
		sign;
	const result = new Date(0);
	result.setUTCFullYear(parsed.year, parsed.month, parsed.day);
	result.setUTCHours(
		parsed.hour,
		parsed.minute,
		parsed.second,
		parsed.millisecond,
	);
	result.setTime(result.getTime() - offsetSeconds * 1_000);
	assertValidDate(result, "timestamptz");
	return result;
}

/** Parse Postgres.js-compatible `date`, whose ISO date string uses UTC. */
export function parsePostgresJsDate(value: string): Date {
	const match = DATE_PATTERN.exec(value);
	if (!match || match[4]) throw new Error("Invalid PostgreSQL date value");
	const parsed: DateParts = {
		year: Number(match[1]),
		month: Number(match[2]) - 1,
		day: Number(match[3]),
		hour: 0,
		minute: 0,
		second: 0,
		millisecond: 0,
	};
	assertDateParts(parsed, "date");
	const result = new Date(0);
	result.setUTCFullYear(parsed.year, parsed.month, parsed.day);
	result.setUTCHours(0, 0, 0, 0);
	assertValidDate(result, "date");
	return result;
}

interface DateParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	readonly millisecond: number;
}

function parts(match: RegExpExecArray): DateParts {
	const rawYear = Number(match[1]);
	return {
		year: match.at(-1) === "BC" ? 1 - rawYear : rawYear,
		month: Number(match[2]) - 1,
		day: Number(match[3]),
		hour: Number(match[4] ?? 0),
		minute: Number(match[5] ?? 0),
		second: Number(match[6] ?? 0),
		millisecond: Number((match[7] ?? "").padEnd(3, "0").slice(0, 3) || 0),
	};
}

function localDate(value: DateParts): Date {
	assertDateParts(value, "date or timestamp");
	const result = new Date(0);
	result.setFullYear(value.year, value.month, value.day);
	result.setHours(value.hour, value.minute, value.second, value.millisecond);
	assertValidDate(result, "date or timestamp");
	return result;
}

function assertDateParts(value: DateParts, type: string): void {
	const daysInMonth = [
		31,
		isLeapYear(value.year) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	const maxDay = daysInMonth[value.month] ?? 0;
	if (
		value.month < 0 ||
		value.month > 11 ||
		value.day < 1 ||
		value.day > maxDay ||
		value.hour < 0 ||
		value.hour > 23 ||
		value.minute < 0 ||
		value.minute > 59 ||
		value.second < 0 ||
		value.second > 59
	) {
		throw new Error(`Invalid PostgreSQL ${type} value`);
	}
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function assertValidDate(value: Date, type: string): void {
	if (!Number.isFinite(value.getTime())) {
		throw new Error(`Invalid PostgreSQL ${type} value`);
	}
}

function parseInfinity(value: string): number | undefined {
	if (value === "infinity") return Infinity;
	if (value === "-infinity") return -Infinity;
	return undefined;
}
