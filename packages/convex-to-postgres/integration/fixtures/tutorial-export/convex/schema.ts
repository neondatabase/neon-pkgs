import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	messages: defineTable({
		body: v.string(),
		author: v.string(),
	}),
	references: defineTable({
		u1: v.optional(v.id("u1")),
		u2: v.optional(v.id("u2")),
		u3: v.optional(v.id("u3")),
		u4: v.optional(v.id("u4")),
	}),
	u1: defineTable({}),
	u2: defineTable({}),
	u3: defineTable({}),
	u4: defineTable({}),
});
