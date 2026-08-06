import { describe, expect, test, vi } from "vitest";

vi.mock("../skills.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ensureSkillsUpToDate: vi.fn().mockResolvedValue(true) };
});

import { handleMigrationsPhase } from "./migrations.js";

describe("handleMigrationsPhase", () => {
	test("asks agent to detect migrations by default", async () => {
		const result = await handleMigrationsPhase({});

		expect(result.phase).toBe("migrations");
		expect(result.status).toBe("detection_needed");
		expect(result.nextAction.type).toBe("agent_check");
		if (result.nextAction.type === "agent_check") {
			expect(result.nextAction.checks[0].id).toBe("existing_migrations");
		}
	});

	test("returns found status when tool is detected", async () => {
		const result = await handleMigrationsPhase({
			tool: "prisma",
			migrationDir: "prisma/migrations",
		});

		expect(result.status).toBe("found");
		expect(result.nextAction.type).toBe("ask_user");
		if (result.nextAction.type === "ask_user") {
			expect(result.nextAction.question).toContain("prisma");
			expect(result.nextAction.responseMapping).toHaveProperty("apply");
		}
	});

	test("returns none_found when tool is none", async () => {
		const result = await handleMigrationsPhase({ tool: "none" });

		expect(result.status).toBe("none_found");
		expect(result.nextAction.type).toBe("ask_user");
		if (result.nextAction.type === "ask_user") {
			expect(result.nextAction.responseMapping).toHaveProperty("prisma");
			expect(result.nextAction.responseMapping).toHaveProperty("drizzle");
			expect(result.nextAction.responseMapping).toHaveProperty("skip");
		}
	});

	test("--scaffold prisma returns agent_action steps", async () => {
		const result = await handleMigrationsPhase({ scaffold: "prisma" });

		expect(result.status).toBe("scaffolding");
		expect(result.nextAction.type).toBe("agent_action");
		if (result.nextAction.type === "agent_action") {
			expect(result.nextAction.steps.length).toBeGreaterThan(0);
			expect(result.nextAction.steps[0].command).toContain("prisma");
		}
	});

	test("--scaffold drizzle returns agent_action steps", async () => {
		const result = await handleMigrationsPhase({ scaffold: "drizzle" });

		expect(result.status).toBe("scaffolding");
		expect(result.nextAction.type).toBe("agent_action");
		if (result.nextAction.type === "agent_action") {
			expect(result.nextAction.steps[0].command).toContain("drizzle");
		}
	});

	test("--apply with tool returns agent_action", async () => {
		const result = await handleMigrationsPhase({
			apply: true,
			tool: "prisma",
		});

		expect(result.status).toBe("applying");
		expect(result.nextAction.type).toBe("agent_action");
		if (result.nextAction.type === "agent_action") {
			const applyStep = result.nextAction.steps.find(
				(s) => s.id === "apply",
			);
			expect(applyStep?.command).toContain("prisma migrate deploy");
		}
	});
});
