export interface SdkGroup {
	keys: readonly string[];
	required: boolean;
	lift?: string;
}

export interface SdkGroups {
	path?: SdkGroup;
	query?: SdkGroup;
	headers?: SdkGroup;
	body?: SdkGroup;
}

export interface SdkInput {
	path?: Record<string, unknown>;
	query?: Record<string, unknown>;
	headers?: Record<string, unknown>;
	body?: Record<string, unknown>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const pick = (
	input: Record<string, unknown>,
	keys: readonly string[],
): Record<string, unknown> => {
	const picked: Record<string, unknown> = {};
	for (const key of keys) {
		if (input[key] !== undefined) {
			picked[key] = input[key];
		}
	}
	return picked;
};

const materializeGroup = (
	input: Record<string, unknown>,
	group: SdkGroup,
): Record<string, unknown> | undefined => {
	if (group.lift !== undefined) {
		const inner = pick(input, group.keys);
		if (Object.keys(inner).length === 0) {
			return group.required ? { [group.lift]: {} } : undefined;
		}
		return { [group.lift]: inner };
	}

	const picked = pick(input, group.keys);
	if (Object.keys(picked).length === 0) {
		return group.required ? {} : undefined;
	}
	return picked;
};

export const toSdkInput = (input: unknown, groups: SdkGroups): SdkInput => {
	if (!isPlainObject(input)) {
		throw new TypeError("Expected tool input to be an object.");
	}

	const sdk: SdkInput = {};
	for (const name of ["path", "query", "headers", "body"] as const) {
		const group = groups[name];
		if (group === undefined) {
			continue;
		}
		const value = materializeGroup(input, group);
		if (value !== undefined) {
			sdk[name] = value;
		}
	}
	return sdk;
};

export const defined = <Value extends Record<string, unknown>>(
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
