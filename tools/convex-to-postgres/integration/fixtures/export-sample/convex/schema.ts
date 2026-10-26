import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// This schema matches the vendored `convex export` snapshot in the parent
// directory (a real convex 1.47.0 deployment). The `authors` and `posts`
// tables are copied verbatim from the scratch deployment's `convex/schema.ts`.
// The `misc` table is declared here to match the `misc/documents.jsonl` the
// export carried (the scratch schema.ts had not been updated to include it);
// its validators mirror the real data: a mixed string/number union stored as
// jsonb, plus two optional fields that are present in some rows and omitted in
// others.
export default defineSchema({
	// Table that will be referenced by another table (v.id target).
	authors: defineTable({
		name: v.string(),
		age: v.number(),
	}).index("by_name", ["name"]),

	// Table exercising a broad spread of validators.
	posts: defineTable({
		title: v.string(),
		count: v.number(),
		published: v.boolean(),
		bigNumber: v.int64(), // bigint
		authorId: v.id("authors"), // cross-table reference
		metadata: v.object({
			tags: v.array(v.string()),
			nested: v.object({
				level: v.number(),
			}),
		}),
		scores: v.array(v.number()),
		optionalNote: v.optional(v.string()),
		status: v.union(
			v.literal("draft"),
			v.literal("active"),
			v.literal("archived"),
		),
		kind: v.union(v.literal(1), v.literal(2)),
		data: v.bytes(), // ArrayBuffer
	})
		.index("by_author", ["authorId"])
		.index("by_status", ["status"]),

	// Mixed-type value plus optional fields, matching the exported misc rows.
	misc: defineTable({
		val: v.union(v.string(), v.number()), // mixed scalar union -> jsonb
		maybe: v.optional(v.number()),
		blob: v.optional(v.bytes()),
	}),
});
