import { describe, expect, test } from "vitest";
import { extractExecutionMetrics, extractTableNamesFromPlan } from "./plan.js";

// Shape of `EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FORMAT JSON)` over the HTTP driver:
// one row whose `QUERY PLAN` column holds the plan document. As in Postgres, the
// root's buffer counters include its children's.
const explainRows = [
	{
		"QUERY PLAN": [
			{
				Plan: {
					"Node Type": "Hash Join",
					"Total Cost": 42.5,
					"Actual Rows": 3,
					"Shared Hit Blocks": 6,
					"Shared Read Blocks": 1,
					"Shared Dirtied Blocks": 1,
					"Local Written Blocks": 5,
					Plans: [
						{
							"Node Type": "Seq Scan",
							"Relation Name": "orders",
							Schema: "public",
							"Total Cost": 20,
							"Actual Rows": 10,
							"Shared Hit Blocks": 2,
							"Local Written Blocks": 5,
						},
						{
							"Node Type": "Hash",
							Plans: [
								{
									"Node Type": "Seq Scan",
									"Relation Name": "customers",
									Schema: "crm",
									"Total Cost": 12,
									"Actual Rows": 2,
									"Shared Dirtied Blocks": 1,
								},
							],
						},
					],
				},
				"Planning Time": 0.25,
				"Execution Time": 1.5,
			},
		],
	},
];

describe("extractTableNamesFromPlan", () => {
	test("finds every scanned relation, schema-qualified and deduplicated", () => {
		expect(
			extractTableNamesFromPlan([...explainRows, ...explainRows]),
		).toEqual(["public.orders", "crm.customers"]);
	});

	test("returns nothing for a plan without relations", () => {
		expect(
			extractTableNamesFromPlan([
				{ "QUERY PLAN": [{ Plan: { "Node Type": "Result" } }] },
			]),
		).toEqual([]);
	});
});

describe("extractExecutionMetrics", () => {
	test("reads timings from the document and totals from the root node only", () => {
		expect(extractExecutionMetrics(explainRows)).toEqual({
			planningTime: 0.25,
			executionTime: 1.5,
			totalCost: 42.5,
			actualRows: 3,
			bufferUsage: {
				shared: { hit: 6, read: 1, written: 0, dirtied: 1 },
				local: { hit: 0, read: 0, written: 5, dirtied: 0 },
			},
		});
	});

	test("throws when the rows are not an EXPLAIN result", () => {
		expect(() => extractExecutionMetrics([{ n: 1 }])).toThrow(
			"EXPLAIN returned no JSON plan document",
		);
	});
});
