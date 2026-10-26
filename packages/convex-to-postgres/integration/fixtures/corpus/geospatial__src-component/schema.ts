import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { point, primitive } from "./types.js";

export default defineSchema({
	points: defineTable({
		key: v.string(),
		coordinates: point,
		sortKey: v.number(),
		filterKeys: v.record(
			v.string(),
			v.union(primitive, v.array(primitive)),
		),
	}).index("key", ["key"]),

	pointsByCell: defineTable({
		cell: v.string(),
		tupleKey: v.string(),
	}).index("cell", ["cell", "tupleKey"]),

	pointsByFilterKey: defineTable({
		filterKey: v.string(),
		filterValue: primitive,
		tupleKey: v.string(),
	}).index("filterKey", ["filterKey", "filterValue", "tupleKey"]),

	approximateCounters: defineTable({
		key: v.string(),
		count: v.number(),
	}).index("key", ["key"]),
});
