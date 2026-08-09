import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeProjectDir } from "../../test_utils/project_dir.js";

vi.mock("../skills.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ensureSkillsUpToDate: vi.fn().mockResolvedValue(true) };
});

import { handleMigrationsPhase } from "./migrations.js";

describe("handleMigrationsPhase", () => {
	let project: ReturnType<typeof makeProjectDir>;

	beforeEach(() => {
		project = makeProjectDir("npm");
	});

	afterEach(() => {
		project.cleanup();
	});

	test("asks agent to detect migrations by default", async () => {
		const result = await handleMigrationsPhase({ cwd: project.dir });

		expect(result.phase).toBe("migrations");
		expect(result.status).toBe("detection_needed");
		expect(result.nextAction.type).toBe("agent_check");
		if (result.nextAction.type === "agent_check") {
			expect(result.nextAction.checks[0].id).toBe("existing_migrations");
		}
	});

	test("returns found status when tool is detected", async () => {
		const result = await handleMigrationsPhase({
			cwd: project.dir,
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
		const result = await handleMigrationsPhase({
			cwd: project.dir,
			tool: "none",
		});

		expect(result.status).toBe("none_found");
		expect(result.nextAction.type).toBe("ask_user");
		if (result.nextAction.type === "ask_user") {
			expect(result.nextAction.responseMapping).toHaveProperty("prisma");
			expect(result.nextAction.responseMapping).toHaveProperty("drizzle");
			expect(result.nextAction.responseMapping).toHaveProperty("skip");
		}
	});

	test("--scaffold prisma returns agent_action steps", async () => {
		const result = await handleMigrationsPhase({
			cwd: project.dir,
			scaffold: "prisma",
		});

		expect(result.status).toBe("scaffolding");
		expect(result.nextAction.type).toBe("agent_action");
		if (result.nextAction.type === "agent_action") {
			expect(result.nextAction.steps.length).toBeGreaterThan(0);
			expect(result.nextAction.steps[0].command).toContain("prisma");
		}
	});

	test("--scaffold drizzle returns agent_action steps", async () => {
		const result = await handleMigrationsPhase({
			cwd: project.dir,
			scaffold: "drizzle",
		});

		expect(result.status).toBe("scaffolding");
		expect(result.nextAction.type).toBe("agent_action");
		if (result.nextAction.type === "agent_action") {
			expect(result.nextAction.steps[0].command).toContain("drizzle");
		}
	});

	describe("scaffold installs use the project's package manager", () => {
		// The dev-dependency flag is the part that differs beyond the verb: bun
		// spells it -d, the other three -D.
		test.each([
			["npm", "npm install -D prisma"],
			["pnpm", "pnpm add -D prisma"],
			["yarn", "yarn add -D prisma"],
			["bun", "bun add -d prisma"],
		] as const)("prisma on %s", async (pm, expected) => {
			const { dir, cleanup } = makeProjectDir(pm);
			try {
				const result = await handleMigrationsPhase({
					cwd: dir,
					scaffold: "prisma",
				});
				expect(result.nextAction.type).toBe("agent_action");
				if (result.nextAction.type !== "agent_action") return;
				const step = result.nextAction.steps.find(
					(s) => s.id === "install_prisma",
				);
				expect(step?.command).toBe(expected);
			} finally {
				cleanup();
			}
		});

		test.each([
			[
				"npm",
				"npm install drizzle-orm @neondatabase/serverless && npm install -D drizzle-kit",
			],
			[
				"pnpm",
				"pnpm add drizzle-orm @neondatabase/serverless && pnpm add -D drizzle-kit",
			],
			[
				"bun",
				"bun add drizzle-orm @neondatabase/serverless && bun add -d drizzle-kit",
			],
		] as const)("drizzle on %s", async (pm, expected) => {
			const { dir, cleanup } = makeProjectDir(pm);
			try {
				const result = await handleMigrationsPhase({
					cwd: dir,
					scaffold: "drizzle",
				});
				expect(result.nextAction.type).toBe("agent_action");
				if (result.nextAction.type !== "agent_action") return;
				const step = result.nextAction.steps.find(
					(s) => s.id === "install_drizzle",
				);
				expect(step?.command).toBe(expected);
			} finally {
				cleanup();
			}
		});
	});

	describe("the tool is invoked through the project's runner too", () => {
		// A step list that installs with bun and then runs the binary with npx is
		// the inconsistency this covers.
		test.each([
			["bun", "bunx drizzle-kit generate && bunx drizzle-kit migrate"],
			[
				"pnpm",
				"pnpm exec drizzle-kit generate && pnpm exec drizzle-kit migrate",
			],
			["npm", "npx drizzle-kit generate && npx drizzle-kit migrate"],
		] as const)("drizzle on %s", async (pm, expected) => {
			const { dir, cleanup } = makeProjectDir(pm);
			try {
				const result = await handleMigrationsPhase({
					cwd: dir,
					scaffold: "drizzle",
				});
				if (result.nextAction.type !== "agent_action")
					throw new Error();
				expect(
					result.nextAction.steps.find(
						(s) => s.id === "run_migration",
					)?.command,
				).toBe(expected);
			} finally {
				cleanup();
			}
		});

		test("applying prisma migrations uses the project's runner", async () => {
			const { dir, cleanup } = makeProjectDir("bun");
			try {
				const result = await handleMigrationsPhase({
					cwd: dir,
					apply: true,
					tool: "prisma",
				});
				if (result.nextAction.type !== "agent_action")
					throw new Error();
				const commands = result.nextAction.steps.map((s) => s.command);
				expect(commands).toContain("bunx prisma migrate deploy");
				expect(commands).toContain("bunx prisma generate");
			} finally {
				cleanup();
			}
		});
	});

	test("--apply with tool returns agent_action", async () => {
		const result = await handleMigrationsPhase({
			cwd: project.dir,
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
