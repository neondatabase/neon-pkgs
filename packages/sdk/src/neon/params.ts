import { NeonClientError } from "./errors.js";
import { err, finalize, type NeonResult } from "./result.js";

/** Validate only the operation-object boundary and its required selectors. */
export function validateParams(
	value: unknown,
	method: string,
	required: Record<string, "string" | "number" | "array"> = {},
): NeonClientError | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return new NeonClientError(
			`${method} expects a named parameter object. See the SDK migration guide.`,
		);
	}
	const params = value as Record<string, unknown>;
	for (const [name, type] of Object.entries(required)) {
		const valid =
			type === "array"
				? Array.isArray(params[name])
				: typeof params[name] === type;
		if (!valid) {
			return new NeonClientError(
				`${method} requires ${name} in its parameter object (${type}).`,
			);
		}
	}
	return undefined;
}

/** Keep invalid JavaScript inputs on the same async result/throw contract. */
export async function invalidParamsResult<T>(
	error: NeonClientError,
	shouldThrow: boolean,
): Promise<T | NeonResult<T>> {
	return finalize(err<T>(error), shouldThrow);
}
