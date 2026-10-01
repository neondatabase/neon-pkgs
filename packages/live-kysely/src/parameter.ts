import {
	encodeTextParameter,
	isTypedRawSqlParameter,
	type PreparedLiveQueryParameter,
} from "@neon/live/server";

interface PostgreSQLCustomValue {
	toPostgres(prepareValue: (value: unknown) => string | null): unknown;
}

export function encodeKyselyParameter(
	value: unknown,
): PreparedLiveQueryParameter {
	if (isTypedRawSqlParameter(value)) {
		return Object.freeze({
			typeOid: value.typeOid,
			value: value.value,
		});
	}
	return encodeTextParameter(prepareValue(value, []));
}

function prepareValue(value: unknown, seen: readonly object[]): string | null {
	if (value === null || value === undefined) return null;
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return String(value);
	}
	if (isDate(value)) return formatDate(value);
	if (ArrayBuffer.isView(value)) return `\\x${encodeHex(value)}`;
	if (Array.isArray(value)) return encodeArray(value, seen);
	if (typeof value === "object") {
		if (hasToPostgres(value)) {
			assertNotCircular(value, seen);
			const nestedSeen = [...seen, value];
			return prepareValue(
				value.toPostgres((nested) => prepareValue(nested, nestedSeen)),
				nestedSeen,
			);
		}
		return encodeJson(value);
	}
	throw new Error(
		"Kysely Live produced a parameter that cannot be encoded as PostgreSQL text",
	);
}

function encodeArray(
	values: readonly unknown[],
	seen: readonly object[],
): string {
	assertNotCircular(values, seen);
	const nestedSeen = [...seen, values];
	return `{${values
		.map((value) => encodeArrayElement(value, nestedSeen))
		.join(",")}}`;
}

function encodeArrayElement(value: unknown, seen: readonly object[]): string {
	if (value === null || value === undefined) return "NULL";
	if (Array.isArray(value)) return encodeArray(value, seen);
	if (ArrayBuffer.isView(value)) return `\\\\x${encodeHex(value)}`;
	const encoded = prepareValue(value, seen);
	if (encoded === null) return "NULL";
	return `"${encoded.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatDate(value: Date): string {
	if (!Number.isFinite(value.getTime())) {
		throw new Error("Invalid Date passed to a Kysely Live parameter");
	}
	let year = value.getFullYear();
	const bc = year < 1;
	if (bc) year = Math.abs(year) + 1;
	let offset = -value.getTimezoneOffset();
	const sign = offset < 0 ? "-" : "+";
	offset = Math.abs(offset);
	const result = [
		String(year).padStart(4, "0"),
		"-",
		twoDigits(value.getMonth() + 1),
		"-",
		twoDigits(value.getDate()),
		"T",
		twoDigits(value.getHours()),
		":",
		twoDigits(value.getMinutes()),
		":",
		twoDigits(value.getSeconds()),
		".",
		String(value.getMilliseconds()).padStart(3, "0"),
		sign,
		twoDigits(Math.floor(offset / 60)),
		":",
		twoDigits(offset % 60),
	].join("");
	return bc ? `${result} BC` : result;
}

function twoDigits(value: number): string {
	return String(value).padStart(2, "0");
}

function isDate(value: unknown): value is Date {
	return Object.prototype.toString.call(value) === "[object Date]";
}

function hasToPostgres(value: object): value is PostgreSQLCustomValue {
	return (
		"toPostgres" in value &&
		typeof (value as { readonly toPostgres?: unknown }).toPostgres ===
			"function"
	);
}

function assertNotCircular(value: object, seen: readonly object[]): void {
	if (seen.includes(value)) {
		throw new Error(
			"Circular reference in a Kysely Live PostgreSQL parameter",
		);
	}
}

function encodeJson(value: object): string {
	try {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new Error();
		return encoded;
	} catch {
		throw new Error(
			"Value cannot be encoded as a Kysely Live PostgreSQL JSON parameter",
		);
	}
}

function encodeHex(value: ArrayBufferView): string {
	const bytes = new Uint8Array(
		value.buffer,
		value.byteOffset,
		value.byteLength,
	);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}
