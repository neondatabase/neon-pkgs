import { type Infer, v } from "convex/values";

export const primitive = v.union(
	v.string(),
	v.number(),
	v.boolean(),
	v.null(),
	v.int64(),
);
export type Primitive = Infer<typeof primitive>;

export function toKey(value: Primitive): string {
	if (typeof value === "string") {
		return `s:${value}`;
	}
	if (typeof value === "number") {
		return `n:${value}`;
	}
	if (typeof value === "boolean") {
		return `b:${value}`;
	}
	if (value === null) {
		return `null`;
	}
	if (typeof value === "bigint") {
		return `i:${value.toString()}`;
	}
	throw new Error("Invalid primitive value");
}
