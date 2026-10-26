import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	// User space crons.
	crons: defineTable({
		name: v.optional(v.string()), // optional
		functionHandle: v.string(),
		args: v.record(v.string(), v.any()),
		schedule: v.union(
			v.object({
				kind: v.literal("interval"),
				ms: v.float64(), // milliseconds
			}),
			v.object({
				kind: v.literal("cron"),
				cronspec: v.string(), // "* * * * *"
				tz: v.optional(v.string()), // optional timezone, e.g. "America/New_York"
			}),
		),
		schedulerJobId: v.optional(v.id("_scheduled_functions")), // job to wait for the next execution
		executionJobId: v.optional(v.id("_scheduled_functions")), // async job to run the function
	}).index("name", ["name"]),
});
