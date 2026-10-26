import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MIN_NODE_VERSION, unsupportedNodeMessage } from "./node_version.js";

describe("unsupportedNodeMessage", () => {
	test("rejects versions below the floor", () => {
		expect(unsupportedNodeMessage("18.19.1", "neon")).toBe(
			"neon requires Node.js 20.19 or newer (found 18.19.1).",
		);
		expect(unsupportedNodeMessage("v20.18.3", "neonctl")).toBe(
			"neonctl requires Node.js 20.19 or newer (found 20.18.3).",
		);
	});

	test("accepts the floor and anything newer", () => {
		for (const version of ["20.19.0", "20.20.1", "22.23.4", "v26.12.1"]) {
			expect(unsupportedNodeMessage(version, "neon")).toBeUndefined();
		}
	});

	test("matches engines.node in package.json", () => {
		const pkg = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
		expect(pkg.engines.node).toBe(`>=${MIN_NODE_VERSION.join(".")}`);
	});
});
