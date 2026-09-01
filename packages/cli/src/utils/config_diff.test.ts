import type { AppliedChange, ConflictReport } from "@neon/config-runtime";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";

import {
	renderAppliedChanges,
	renderBranchSettingConflicts,
} from "./config_diff";

describe("renderBranchSettingConflicts", () => {
	it("returns empty string when there are no conflicts", () => {
		expect(renderBranchSettingConflicts([], { color: false })).toBe("");
	});

	it("renders a sorted before→after diff grouped by branch", () => {
		const conflicts: ConflictReport[] = [
			{
				kind: "branch",
				identifier: "feature/x",
				field: "ttl",
				current: null,
				desired: "2026-07-20T00:00:00Z",
				reason: "…",
			},
			{
				kind: "branch",
				identifier: "feature/x",
				field: "protected",
				current: false,
				desired: true,
				reason: "…",
			},
		];

		const text = renderBranchSettingConflicts(conflicts, { color: false });
		const lines = text.split("\n");
		expect(lines[0]).toBe(
			"Branch settings differ (re-run with --update-existing to apply)",
		);
		expect(lines[1]).toBe("  ~ feature/x");
		// Fields are sorted alphabetically: protected before ttl.
		expect(lines[2]).toMatch(/^ {6}protected\s+false → true$/);
		expect(lines[3]).toMatch(
			/^ {6}ttl\s+\(unset\) → 2026-07-20T00:00:00Z$/,
		);
	});

	it("expands object-valued settings into sorted per-key lines", () => {
		const conflicts: ConflictReport[] = [
			{
				kind: "branch",
				identifier: "main",
				field: "computeSettings",
				current: { autoscalingLimitMaxCu: 2 },
				desired: { autoscalingLimitMaxCu: 4 },
				reason: "…",
			},
		];
		const text = renderBranchSettingConflicts(conflicts, { color: false });
		expect(text).toContain("computeSettings.autoscalingLimitMaxCu  2 → 4");
	});

	it("adds ANSI codes only when color is on (same layout stripped)", () => {
		const conflicts: ConflictReport[] = [
			{
				kind: "branch",
				identifier: "b",
				field: "protected",
				current: false,
				desired: true,
				reason: "…",
			},
		];
		const plain = renderBranchSettingConflicts(conflicts, {
			color: false,
		});
		const colored = renderBranchSettingConflicts(conflicts, {
			color: true,
		});
		expect(stripAnsi(colored)).toBe(plain);
	});
});

describe("renderAppliedChanges", () => {
	it("returns empty string when there are no changes", () => {
		expect(
			renderAppliedChanges([], "Planned changes", { color: false }),
		).toBe("");
	});

	it("lists service changes as + adds and branch updates as desired-only", () => {
		const changes: AppliedChange[] = [
			{ kind: "service", action: "create", identifier: "auth" },
			{
				kind: "service",
				action: "create",
				identifier: "bucket:avatars",
			},
			{
				kind: "branch",
				action: "update",
				identifier: "feature/x",
				details: { field: "ttl", expiresAt: "2026-07-20T00:00:00Z" },
			},
			{
				kind: "branch",
				action: "update",
				identifier: "feature/x",
				details: { field: "protected", protected: true },
			},
		];

		const text = renderAppliedChanges(changes, "Planned changes", {
			color: false,
		});
		const lines = text.split("\n");
		expect(lines[0]).toBe("Planned changes");
		// Services first (sorted), rendered as + adds with friendly labels.
		expect(lines[1]).toBe("  + Neon Auth");
		expect(lines[2]).toBe("  + bucket avatars");
		// Branch group with sorted, desired-only field lines (no red "before").
		expect(lines[3]).toBe("  ~ feature/x");
		expect(lines[4]).toMatch(/^ {6}protected\s+→ true$/);
		expect(lines[5]).toMatch(/^ {6}ttl\s+→ 2026-07-20T00:00:00Z$/);
	});

	it("renders the settings a branch creation applied, parent included", () => {
		// `createBranch` reports what the create call itself carried using the same shapes a
		// push produces, so a setting applied at creation reads exactly like one applied
		// after — including `parent`, which only ever comes from a creation.
		const changes: AppliedChange[] = [
			{
				kind: "branch",
				action: "create",
				identifier: "feature-x",
				details: { field: "parent", parent: "main" },
			},
			{
				kind: "branch",
				action: "create",
				identifier: "feature-x",
				details: {
					field: "ttl",
					expiresAt: "2026-07-26T06:36:56.608Z",
				},
			},
			{
				kind: "branch",
				action: "create",
				identifier: "feature-x",
				details: { field: "protected", protected: false },
			},
			{
				kind: "branch",
				action: "create",
				identifier: "feature-x",
				details: {
					field: "computeSettings",
					settings: {
						autoscalingLimitMaxCu: 2,
						suspendTimeout: "5m",
					},
				},
			},
		];

		const lines = renderAppliedChanges(changes, "neon.ts applied", {
			color: false,
		}).split("\n");

		expect(lines[0]).toBe("neon.ts applied");
		expect(lines[1]).toBe("  ~ feature-x");
		// One group, fields sorted, object settings expanded per key.
		expect(lines[2]).toMatch(
			/^ {6}computeSettings\.autoscalingLimitMaxCu\s+→ 2$/,
		);
		expect(lines[3]).toMatch(
			/^ {6}computeSettings\.suspendTimeout\s+→ 5m$/,
		);
		expect(lines[4]).toMatch(/^ {6}parent\s+→ main$/);
		expect(lines[5]).toMatch(/^ {6}protected\s+→ false$/);
		expect(lines[6]).toMatch(/^ {6}ttl\s+→ 2026-07-26T06:36:56\.608Z$/);
		expect(lines).toHaveLength(7);
	});

	it("renders a re-deployed function (update) as a ~ line and never leaks the URL", () => {
		const changes: AppliedChange[] = [
			{
				kind: "service",
				action: "update",
				identifier: "function:api",
				details: {
					slug: "api",
					invocationUrl: "https://br-x.neon.tech/functions/api",
				},
			},
		];
		const text = renderAppliedChanges(changes, "Applied changes", {
			color: false,
		});
		expect(text).toContain("~ function api");
		expect(text).not.toContain("invocationUrl");
		expect(text).not.toContain("https://");
	});

	it("renders a Data API disable as a - line", () => {
		const changes: AppliedChange[] = [
			{ kind: "service", action: "delete", identifier: "dataApi" },
		];
		const text = renderAppliedChanges(changes, "Applied changes", {
			color: false,
		});
		expect(text.split("\n")[1]).toBe("  - Data API");
	});
});
