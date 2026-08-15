import { encodeBlob } from "./binary.js";
import type { JsonSafe, NeonToolResult } from "./operation.js";

function toJsonSafe<Value>(value: Value): Promise<JsonSafe<Value>>;
async function toJsonSafe(value: unknown): Promise<unknown> {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (
		typeof value === "string" ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return value;
	}
	if (value instanceof Blob) {
		return encodeBlob(value);
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Array.isArray(value)) {
		return Promise.all(value.map(toJsonSafe));
	}
	if (typeof value === "object") {
		const entries = await Promise.all(
			Object.entries(value).map(async ([key, child]) => [
				key,
				await toJsonSafe(child),
			]),
		);
		return Object.fromEntries(entries);
	}
	throw new TypeError(`Unsupported tool result value: ${typeof value}`);
}

export const toToolResult = async <Value>(
	value: Value,
): Promise<NeonToolResult<JsonSafe<Value>>> => ({
	data: await toJsonSafe(value),
});
