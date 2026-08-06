import { describe, expect, test, vi } from "vitest";
import { routeDataStep } from "./route_command.js";

// Mock execa for setup phase (it runs add-mcp, skills install, etc.)
vi.mock("execa", () => ({
	execa: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
}));

// Mock extension helpers
vi.mock("./extension.js", () => ({
	findEditorCommand: vi.fn().mockResolvedValue(null),
}));

// Mock skills evergreen check
vi.mock("./skills.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ensureSkillsUpToDate: vi.fn().mockResolvedValue(true) };
});

describe("routeDataStep", () => {
	test("routes to auth via step field", async () => {
		const result = (await routeDataStep(
			{ step: "auth", verify: true },
			undefined,
		)) as { phase: string };
		expect(result.phase).toBe("auth");
	});

	test("routes to getting-started via step field", async () => {
		const result = (await routeDataStep(
			{ step: "getting-started", framework: "next" },
			undefined,
		)) as { phase: string; status: string };
		expect(result.phase).toBe("setup");
		expect(result.status).toBe("getting_started");
	});

	test("routes to migrations via step field", async () => {
		const result = (await routeDataStep(
			{ step: "migrations", tool: "prisma" },
			undefined,
		)) as { phase: string };
		expect(result.phase).toBe("migrations");
	});

	test("unwraps a nested data payload", async () => {
		const result = (await routeDataStep(
			{
				step: "getting-started",
				data: JSON.stringify({
					framework: "next",
					migrationTool: "prisma",
				}),
			},
			undefined,
		)) as {
			phase: string;
			status: string;
			nextAction: { type: string; steps?: { id: string }[] };
		};
		expect(result.phase).toBe("setup");
		expect(result.status).toBe("getting_started");
		if (result.nextAction.type === "agent_action") {
			const stepIds = result.nextAction.steps?.map((s) => s.id);
			expect(stepIds).toContain("run_migrations");
		}
	});

	test("prefers agentId from the payload over the caller's agent", async () => {
		const result = (await routeDataStep(
			{ step: "skills", agentId: "cursor", status: true },
			"claude-code",
		)) as { phase: string };
		expect(result.phase).toBe("tooling");
	});

	test("throws on unknown step", async () => {
		await expect(
			routeDataStep({ step: "bogus" }, undefined),
		).rejects.toThrow("Unknown step");
	});
});
