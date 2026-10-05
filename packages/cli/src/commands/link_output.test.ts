import { describe, expect, test } from "vitest";
import { formatLinkSummary } from "./link_output.js";

const cwd = "/work/my-app";

describe("formatLinkSummary", () => {
	test("names a created project and omits a missing org", () => {
		expect(
			formatLinkSummary(
				{
					contextFile: "/work/my-app/.neon",
					projectId: "proj-1",
					projectName: "my-app",
					branch: "main",
					created: true,
					regionId: "aws-us-east-2",
				},
				cwd,
			),
		).toBe(
			[
				"Created project my-app in aws-us-east-2",
				"Linked .neon",
				"  Project         my-app (proj-1)",
				"  Branch          main",
				"",
			].join("\n"),
		);
	});
});
