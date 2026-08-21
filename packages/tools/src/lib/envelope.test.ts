import { describe, expect, test } from "vitest";
import { decodeBinaryFields, toSdkInput } from "./envelope.js";

describe("toSdkInput", () => {
	test("lifts createProject fields into body.project", () => {
		expect(
			toSdkInput(
				{ name: "my-app", region_id: "aws-us-east-2" },
				{
					body: {
						keys: ["name", "region_id"],
						required: true,
						lift: "project",
					},
				},
			),
		).toEqual({
			body: { project: { name: "my-app", region_id: "aws-us-east-2" } },
		});
	});

	test("omits an optional empty body and emits {} for a required empty body", () => {
		expect(
			toSdkInput(
				{ project_id: "project-id" },
				{
					path: { keys: ["project_id"], required: true },
					body: { keys: ["name"], required: false },
				},
			),
		).toEqual({ path: { project_id: "project-id" } });
		expect(
			toSdkInput(
				{ project_id: "project-id" },
				{
					path: { keys: ["project_id"], required: true },
					body: { keys: [], required: true },
				},
			),
		).toEqual({ path: { project_id: "project-id" }, body: {} });
	});

	test("does not put restoreSnapshot name on query", () => {
		expect(
			toSdkInput(
				{
					project_id: "project-id",
					snapshot_id: "snapshot-id",
					name: "restored",
				},
				{
					path: {
						keys: ["project_id", "snapshot_id"],
						required: true,
					},
					body: {
						keys: ["name", "target_branch_id", "finalize_restore"],
						required: false,
					},
				},
			),
		).toEqual({
			path: { project_id: "project-id", snapshot_id: "snapshot-id" },
			body: { name: "restored" },
		});
	});
});

describe("decodeBinaryFields", () => {
	test("decodes named string fields and leaves the rest", () => {
		const blob = new Blob(["hi"]);
		expect(
			decodeBinaryFields(
				{ zip: "aGVsbG8=", runtime: "deno" },
				["zip"],
				() => blob,
			),
		).toEqual({ zip: blob, runtime: "deno" });
	});
});
