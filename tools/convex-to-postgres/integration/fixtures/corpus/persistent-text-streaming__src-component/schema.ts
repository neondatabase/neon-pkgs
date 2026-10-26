import { defineSchema, defineTable } from "convex/server";
import { type Infer, v } from "convex/values";

export const streamStatusValidator = v.union(
	v.literal("pending"),
	v.literal("streaming"),
	v.literal("done"),
	v.literal("error"),
	v.literal("timeout"),
);
export type StreamStatus = Infer<typeof streamStatusValidator>;

export default defineSchema({
	streams: defineTable({
		status: streamStatusValidator,
	}).index("byStatus", ["status"]),
	chunks: defineTable({
		streamId: v.id("streams"),
		text: v.string(),
	}).index("byStream", ["streamId"]),
});
