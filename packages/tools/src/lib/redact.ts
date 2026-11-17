export const REDACTED_SECRET = "***redacted***";

type Segment = { key: string } | { each: true };

const parsePath = (path: string): Segment[] => {
	if (!path.startsWith("$")) {
		throw new TypeError(`Secret path must start with $: ${path}`);
	}
	const segments: Segment[] = [];
	const pattern = /\.([a-zA-Z_][a-zA-Z0-9_]*)|\[\*\]/gy;
	pattern.lastIndex = 1;
	while (pattern.lastIndex < path.length) {
		const match = pattern.exec(path);
		if (match === null) {
			throw new TypeError(`Unsupported secret path: ${path}`);
		}
		segments.push(
			match[1] === undefined ? { each: true } : { key: match[1] },
		);
	}
	return segments;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const redactAt = (
	value: unknown,
	segments: readonly Segment[],
	path: string,
): unknown => {
	if (value === undefined || value === null) {
		return value;
	}
	const [head, ...rest] = segments;
	if (head === undefined) {
		if (typeof value !== "string") {
			throw new TypeError(`Secret at ${path} is not a string`);
		}
		return value === "" ? value : REDACTED_SECRET;
	}
	if ("each" in head) {
		if (!Array.isArray(value)) {
			throw new TypeError(`Secret path ${path} expects an array`);
		}
		return value.map((item) => redactAt(item, rest, path));
	}
	if (!isRecord(value)) {
		throw new TypeError(`Secret path ${path} expects an object`);
	}
	if (!(head.key in value)) {
		return value;
	}
	return { ...value, [head.key]: redactAt(value[head.key], rest, path) };
};

/**
 * Replaces every non-empty string at `paths` with `REDACTED_SECRET`. An absent,
 * null, or empty value is left as is, so "no secret" stays distinguishable
 * from "redacted". A path that meets a different shape throws.
 */
export const redactSecretFields = (
	data: unknown,
	paths: readonly string[],
): unknown =>
	paths.reduce(
		(current, path) => redactAt(current, parsePath(path), path),
		data,
	);
