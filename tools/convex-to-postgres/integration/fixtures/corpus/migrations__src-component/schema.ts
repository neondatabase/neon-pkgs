import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	migrations: defineTable({
		name: v.string(), // Defaults to the function name.
		cursor: v.union(v.string(), v.null()),
		isDone: v.boolean(),
		workerId: v.optional(v.id("_scheduled_functions")),
		error: v.optional(v.string()),
		// The number of documents processed so far.
		processed: v.number(),
		latestStart: v.number(),
		latestEnd: v.optional(v.number()),
	})
		.index("name", ["name"])
		.index("isDone", ["isDone"]),
});
