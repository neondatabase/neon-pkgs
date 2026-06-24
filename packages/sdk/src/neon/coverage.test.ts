import { describe, expect, it } from "vitest";
import * as sdk from "../client/sdk.gen.js";
import { EXPECTED_OPERATIONS, WRAPPED } from "./coverage.js";

const generatedOps = new Set(
	Object.entries(sdk)
		.filter(([, value]) => typeof value === "function")
		.map(([name]) => name),
);

describe("ergonomic-layer drift guard", () => {
	it("the generated operation set matches the committed snapshot", () => {
		const added = [...generatedOps]
			.filter((op) => !EXPECTED_OPERATIONS.has(op))
			.sort();
		const removed = [...EXPECTED_OPERATIONS]
			.filter((op) => !generatedOps.has(op))
			.sort();
		// If this fails after `pnpm generate`, the spec changed. Triage `added` ops into a
		// resource namespace (and WRAPPED) or accept them as raw-only, then update the
		// snapshot in coverage.ts. See coverage.ts for the workflow.
		expect({ added, removed }).toStrictEqual({ added: [], removed: [] });
	});

	it("every wrapped operation exists in the generated client", () => {
		const missing = [...WRAPPED]
			.filter((op) => !generatedOps.has(op))
			.sort();
		expect(missing).toStrictEqual([]);
	});
});
