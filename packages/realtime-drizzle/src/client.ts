/**
 * Result parsers matching Drizzle's ordinary PostgreSQL column defaults.
 *
 * @module Drizzle client
 */

import {
	defineParsers,
	type PostgreSQLParsers,
	pgTypeOids,
} from "@neon/realtime/client";

/**
 * Parser overrides for Drizzle-compatible hydrated values.
 *
 * PostgreSQL `date` remains a string and zone-less `timestamp` is interpreted
 * as UTC, matching Drizzle's default PostgreSQL column modes. Spread this
 * preset into `createRealtimeClient({ parsers })`. Per-column Drizzle modes are
 * intentionally outside this OID-only compatibility layer.
 */
export const drizzleParsers: PostgreSQLParsers = defineParsers({
	[pgTypeOids.date]: parseDateString,
	[pgTypeOids.timestamp]: parseTimestampAsUtc,
});

function parseDateString(value: string): string {
	return value;
}

function parseTimestampAsUtc(value: string): Date {
	const match =
		/^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(
			value,
		);
	if (!match) throw new Error("Invalid PostgreSQL timestamp value");
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (
		!validDate(year, month, day) ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		throw new Error("Invalid PostgreSQL timestamp value");
	}
	const result = new Date(0);
	result.setUTCFullYear(year, month - 1, day);
	result.setUTCHours(
		hour,
		minute,
		second,
		Number((match[7] ?? "").padEnd(3, "0").slice(0, 3) || 0),
	);
	if (!Number.isFinite(result.getTime())) {
		throw new Error("Invalid PostgreSQL timestamp value");
	}
	return result;
}

function validDate(year: number, month: number, day: number): boolean {
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	const maxDay = days[month - 1] ?? 0;
	return month >= 1 && month <= 12 && day >= 1 && day <= maxDay;
}
