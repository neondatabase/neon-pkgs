import { describe, expect, test, vi } from "vitest";
import { routeCommand } from "./route-command.js";

// Mock execa for setup phase (it runs add-mcp, skills install, etc.)
vi.mock("execa", () => ({
	execa: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
}));

// Mock extension helpers
vi.mock("../lib/extension.js", () => ({
	findEditorCommand: vi.fn().mockResolvedValue(null),
}));

// Mock skills evergreen check
vi.mock("../skills.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ensureSkillsUpToDate: vi.fn().mockResolvedValue(true) };
});

describe("routeCommand", () => {
	test("routes to orchestrator when no subcommand", async () => {
		const result = await routeCommand(["--json"]);
		// Should return a phase response from the orchestrator
		expect(result).toHaveProperty("phase");
		expect(result).toHaveProperty("nextAction");
	});

	test("routes to auth subcommand", async () => {
		const result = await routeCommand(["auth", "--json", "--verify"]);
		expect(result.phase).toBe("auth");
	});

	test("routes to getting-started subcommand", async () => {
		const result = await routeCommand([
			"getting-started",
			"--json",
			"--framework",
			"next",
			"--orm",
			"prisma",
		]);
		expect(result.phase).toBe("setup");
		expect(result.status).toBe("getting_started");
		expect(result.nextAction.type).toBe("agent_action");
	});

	test("routes to setup with --data JSON", async () => {
		const data = JSON.stringify({
			consent: "proceed",
			mcpConfigured: false,
			connectionString: false,
			framework: "next",
			orm: "prisma",
			migrationTool: "prisma",
			migrationDir: "prisma/migrations",
			isVscodeIde: true,
			mode: "defaults",
			agent: "cursor",
		});
		const result = await routeCommand(["setup", "--json", "--data", data]);
		expect(result.phase).toBe("setup");
		// Should have run installation (defaults mode)
		expect(result).toHaveProperty("results");
	});

	test("routes to mcp subcommand", async () => {
		const result = await routeCommand([
			"mcp",
			"--json",
			"--mcp-configured",
			"false",
		]);
		expect(result.phase).toBe("tooling");
	});

	test("routes to skills subcommand", async () => {
		const result = await routeCommand(["skills", "--json"]);
		expect(result.phase).toBe("tooling");
	});

	test("handles -a short flag for --agent", async () => {
		const result = await routeCommand([
			"auth",
			"--json",
			"-a",
			"cursor",
			"--verify",
		]);
		expect(result.phase).toBe("auth");
	});

	test("parses camelCase flags correctly", async () => {
		const result = await routeCommand([
			"getting-started",
			"--json",
			"--has-connection-string",
			"--migration-tool",
			"prisma",
		]);
		expect(result.phase).toBe("setup");
		expect(result.status).toBe("getting_started");
		if (result.nextAction.type === "agent_action") {
			const stepIds = result.nextAction.steps.map(
				(s: { id: string }) => s.id,
			);
			expect(stepIds).toContain("run_migrations");
		}
	});
});
