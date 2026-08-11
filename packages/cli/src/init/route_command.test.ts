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

	test("routes to setup via step field", async () => {
		const result = (await routeDataStep({ step: "setup" }, undefined)) as {
			phase: string;
			status: string;
		};
		expect(result.phase).toBe("setup");
		expect(result.status).toBe("pending");
	});

	test("routes to mcp via step field", async () => {
		const result = (await routeDataStep(
			{ step: "mcp", status: true },
			undefined,
		)) as { phase: string };
		expect(result.phase).toBe("tooling");
	});

	test("routes to skills via step field", async () => {
		const result = (await routeDataStep(
			{ step: "skills", status: true },
			undefined,
		)) as { phase: string };
		expect(result.phase).toBe("tooling");
	});

	test("unwraps a nested data payload", async () => {
		const result = (await routeDataStep(
			{
				step: "skills",
				data: JSON.stringify({ status: true }),
			},
			undefined,
		)) as { phase: string; nextAction: { type: string } };
		expect(result.phase).toBe("tooling");
		expect(result.nextAction.type).toBe("agent_check");
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
