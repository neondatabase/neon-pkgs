const defined = <Value extends Record<string, unknown>>(
	value: Value,
): Value => {
	const next: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (child !== undefined) {
			next[key] = child;
		}
	}
	return next as Value;
};

export function optionalGroup<Value extends Record<string, unknown>>(
	value: Value,
	required: true,
): Value;
export function optionalGroup<Value extends Record<string, unknown>>(
	value: Value,
	required: false,
): Value | undefined;
export function optionalGroup<Value extends Record<string, unknown>>(
	value: Value,
	required: boolean,
): Value | undefined {
	const next = defined(value);
	if (!required && Object.keys(next).length === 0) {
		return undefined;
	}
	return next;
}

export function decodeBinaryFields(
	body: Record<string, unknown>,
	fields: readonly string[],
	decode: (value: string) => Blob,
): Record<string, unknown>;
export function decodeBinaryFields(
	body: Record<string, unknown> | undefined,
	fields: readonly string[],
	decode: (value: string) => Blob,
): Record<string, unknown> | undefined;
export function decodeBinaryFields(
	body: Record<string, unknown> | undefined,
	fields: readonly string[],
	decode: (value: string) => Blob,
): Record<string, unknown> | undefined {
	if (body === undefined) {
		return undefined;
	}
	const next: Record<string, unknown> = { ...body };
	for (const field of fields) {
		const value = next[field];
		if (typeof value === "string") {
			next[field] = decode(value);
		}
	}
	return next;
}
