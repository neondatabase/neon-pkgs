import { defineSchema, defineTable } from "convex/server";
import { type Value as ConvexValue, type Infer, v } from "convex/values";

const item = v.object({
	// key, usually an index key.
	k: v.any(),
	// value, usually an id.
	v: v.any(),
	// summand, to be aggregated by summing.
	s: v.number(),
});

export type Item = {
	k: ConvexValue;
	v: ConvexValue;
	s: number;
};

export const itemValidator = v.object({
	k: v.any(),
	v: v.any(),
	s: v.number(),
});

export const aggregate = v.object({
	count: v.number(),
	sum: v.number(),
});

export type Aggregate = Infer<typeof aggregate>;

export const vOperation = v.union(
	v.object({
		type: v.literal("insert"),
		key: v.any(),
		value: v.any(),
		summand: v.optional(v.number()),
		namespace: v.optional(v.any()),
	}),
	v.object({
		type: v.literal("delete"),
		key: v.any(),
		namespace: v.optional(v.any()),
	}),
	v.object({
		type: v.literal("replace"),
		currentKey: v.any(),
		newKey: v.any(),
		value: v.any(),
		summand: v.optional(v.number()),
		namespace: v.optional(v.any()),
		newNamespace: v.optional(v.any()),
	}),
	v.object({
		type: v.literal("deleteIfExists"),
		key: v.any(),
		namespace: v.optional(v.any()),
	}),
	v.object({
		type: v.literal("replaceOrInsert"),
		currentKey: v.any(),
		newKey: v.any(),
		value: v.any(),
		summand: v.optional(v.number()),
		namespace: v.optional(v.any()),
		newNamespace: v.optional(v.any()),
	}),
);

export type Operation = Infer<typeof vOperation>;

export default defineSchema({
	// One per namespace
	btree: defineTable({
		root: v.id("btreeNode"),
		namespace: v.optional(v.any()),
		maxNodeSize: v.number(),
	}).index("by_namespace", ["namespace"]),
	btreeNode: defineTable({
		items: v.array(item),
		subtrees: v.array(v.id("btreeNode")),
		aggregate: v.optional(aggregate),
	}),
	pendingOperations: defineTable({
		commitTs: v.commitTs(),
		operations: v.array(vOperation),
	}).index("by_commitTs", ["commitTs"]),
	deadLetterOperations: defineTable({
		commitTs: v.int64(),
		operation: vOperation,
		error: v.string(),
	}).index("by_commitTs", ["commitTs"]),
});
