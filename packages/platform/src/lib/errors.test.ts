import { describe, expect, test } from "vitest";
import {
	bugReportFooter,
	ConfigValidationError,
	ErrorCode,
	PlatformError,
	PushConflictError,
} from "./errors.js";

describe("PlatformError", () => {
	test("carries code and details", () => {
		const err = new PlatformError(ErrorCode.NotFound, "msg", {
			details: { requestId: "req-1", status: 404 },
		});
		expect(err.code).toBe(ErrorCode.NotFound);
		expect(err.details).toEqual({ requestId: "req-1", status: 404 });
	});

	test("freezes details so callers can't mutate the error in-place", () => {
		const err = new PlatformError(ErrorCode.NotFound, "msg", {
			details: { foo: "bar" },
		});
		expect(Object.isFrozen(err.details)).toBe(true);
	});
});

describe("ConfigValidationError", () => {
	test("aggregates issues into a single multi-line message", () => {
		const err = new ConfigValidationError([
			"project.name: must not be empty",
			"branchBlueprints.preview.ttl: invalid duration",
		]);
		expect(err.message).toContain("project.name: must not be empty");
		expect(err.message).toContain(
			"branchBlueprints.preview.ttl: invalid duration",
		);
		expect(err.code).toBe(ErrorCode.InvalidConfig);
		expect(err.issues).toHaveLength(2);
	});
});

describe("PushConflictError — message generation", () => {
	test("mutable branch drift only → suggests updateExisting", () => {
		const err = new PushConflictError([
			{
				kind: "branch",
				identifier: "production",
				field: "computeSettings",
				current: { autoscalingLimitMaxCu: 1 },
				desired: { autoscalingLimitMaxCu: 2 },
				reason: "drift",
			},
		]);
		expect(err.message).toContain("updateExisting: true");
		expect(err.message).not.toContain("immutable on Neon");
	});

	test("immutable region conflict → explains it cannot be applied", () => {
		const err = new PushConflictError([
			{
				kind: "project",
				identifier: "proj-1",
				field: "region",
				current: "aws-us-east-1",
				desired: "aws-eu-central-1",
				reason: "Region is immutable on Neon.",
			},
		]);
		expect(err.message).toContain("immutable on Neon");
		expect(err.message).toContain("recreate the project");
	});

	test("mixed mutable + immutable → both hints appear", () => {
		const err = new PushConflictError([
			{
				kind: "project",
				identifier: "proj-1",
				field: "region",
				current: "aws-us-east-1",
				desired: "aws-eu-central-1",
				reason: "Region is immutable.",
			},
			{
				kind: "branch",
				identifier: "production",
				field: "computeSettings",
				current: {},
				desired: { autoscalingLimitMaxCu: 2 },
				reason: "drift",
			},
		]);
		expect(err.message).toContain("immutable on Neon");
		expect(err.message).toContain("updateExisting: true");
	});

	test("renders per-conflict current/desired/fix lines", () => {
		const err = new PushConflictError([
			{
				kind: "branch",
				identifier: "production",
				field: "ttl",
				current: null,
				desired: "2025-06-09T18:02:16Z",
				reason: "drift",
			},
		]);
		expect(err.message).toContain("current :");
		expect(err.message).toContain("desired :");
		expect(err.message).toContain("fix     :");
		expect(err.message).toContain("`updateExisting: true`");
	});

	test("missing parent suggests creating the parent first", () => {
		const err = new PushConflictError([
			{
				kind: "branch",
				identifier: "feature",
				field: "parent",
				current: undefined,
				desired: "release",
				reason: "missing",
			},
		]);
		expect(err.message).toContain("create the parent branch on Neon first");
	});
});

describe("bugReportFooter", () => {
	test("includes the GitHub issue link", () => {
		expect(bugReportFooter()).toContain(
			"github.com/neondatabase/neon-pkgs/issues",
		);
	});
});
