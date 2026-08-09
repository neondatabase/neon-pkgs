import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../skills.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ensureSkillsUpToDate: vi.fn().mockResolvedValue(true) };
});

import { handleGettingStartedPhase } from "./getting_started.js";

describe("getting-started phase", () => {
	test("returns agent_action with getting-started prerequisite", async () => {
		const result = await handleGettingStartedPhase({ agent: "claude" });

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("getting_started");
		expect(result.nextAction.type).toBe("agent_action");

		if (result.nextAction.type === "agent_action") {
			expect(result.nextAction.prerequisite).toContain(
				"getting-started.md",
			);
			expect(result.nextAction.onComplete.type).toBe("run_neon_init");
		}
	});

	test("includes org selection, project selection, and connection string steps when no connection string", async () => {
		const result = await handleGettingStartedPhase({
			agent: "claude",
			hasConnectionString: false,
		});

		if (result.nextAction.type === "agent_action") {
			const stepIds = result.nextAction.steps.map((s) => s.id);
			expect(stepIds).toContain("select_org");
			expect(stepIds).toContain("select_or_create_project");
			expect(stepIds).toContain("create_project_if_needed");
			expect(stepIds).toContain("pull_env");
			// Org step should list orgs first
			const orgStep = result.nextAction.steps.find(
				(s) => s.id === "select_org",
			);
			expect(orgStep?.command).toContain("neon orgs list");
			expect(orgStep?.description).toContain("CLI");
			// Create step should include --org-id
			const createStep = result.nextAction.steps.find(
				(s) => s.id === "create_project_if_needed",
			);
			expect(createStep?.command).toContain("--org-id");
		}
	});

	test("skips project creation steps when connection string exists", async () => {
		const result = await handleGettingStartedPhase({
			agent: "claude",
			hasConnectionString: true,
		});

		if (result.nextAction.type === "agent_action") {
			const stepIds = result.nextAction.steps.map((s) => s.id);
			expect(stepIds).not.toContain("select_org");
			expect(stepIds).not.toContain("select_or_create_project");
			expect(stepIds).not.toContain("pull_env");
		}
	});

	test("includes prisma driver install when ORM is prisma", async () => {
		const result = await handleGettingStartedPhase({
			agent: "claude",
			hasConnectionString: false,
			orm: "prisma",
		});

		if (result.nextAction.type === "agent_action") {
			const stepIds = result.nextAction.steps.map((s) => s.id);
			expect(stepIds).toContain("install_driver");
			const driverStep = result.nextAction.steps.find(
				(s) => s.id === "install_driver",
			);
			expect(driverStep?.command).toContain("@neondatabase/serverless");
			expect(driverStep?.command).toContain("@prisma/adapter-neon");
		}
	});

	test("includes drizzle driver install when ORM is drizzle", async () => {
		const result = await handleGettingStartedPhase({
			agent: "claude",
			hasConnectionString: false,
			orm: "drizzle",
		});

		if (result.nextAction.type === "agent_action") {
			const driverStep = result.nextAction.steps.find(
				(s) => s.id === "install_driver",
			);
			expect(driverStep?.command).toContain("@neondatabase/serverless");
			expect(driverStep?.command).not.toContain("@prisma/adapter-neon");
		}
	});

	test("includes migration command when migration tool detected", async () => {
		const result = await handleGettingStartedPhase({
			agent: "claude",
			hasConnectionString: true,
			migrationTool: "prisma",
		});

		if (result.nextAction.type === "agent_action") {
			const stepIds = result.nextAction.steps.map((s) => s.id);
			expect(stepIds).toContain("run_migrations");
			const migrationStep = result.nextAction.steps.find(
				(s) => s.id === "run_migrations",
			);
			expect(migrationStep?.command).toBe("npx prisma migrate deploy");
		}
	});

	test("includes knex migration command", async () => {
		const result = await handleGettingStartedPhase({
			agent: "claude",
			hasConnectionString: true,
			migrationTool: "knex",
		});

		if (result.nextAction.type === "agent_action") {
			const migrationStep = result.nextAction.steps.find(
				(s) => s.id === "run_migrations",
			);
			expect(migrationStep?.command).toBe("npx knex migrate:latest");
		}
	});

	describe("install commands follow the project's package manager", () => {
		let project: string;

		beforeEach(() => {
			project = mkdtempSync(join(tmpdir(), "neon-getting-started-"));
			// Stops lockfile detection from walking into $TMPDIR's ancestors.
			mkdirSync(join(project, ".git"));
		});

		afterEach(() => {
			rmSync(project, { recursive: true, force: true });
		});

		test("uses pnpm for both the dependency install and the driver install", async () => {
			writeFileSync(join(project, "pnpm-lock.yaml"), "");

			const result = await handleGettingStartedPhase({
				agent: "claude",
				cwd: project,
				hasConnectionString: false,
				orm: "prisma",
			});

			expect(result.nextAction.type).toBe("agent_action");
			if (result.nextAction.type !== "agent_action") return;
			const commandOf = (id: string) =>
				result.nextAction.type === "agent_action"
					? result.nextAction.steps.find((s) => s.id === id)?.command
					: undefined;

			expect(commandOf("install_dependencies")).toBe("pnpm install");
			expect(commandOf("install_driver")).toBe(
				"pnpm add @neondatabase/serverless @prisma/adapter-neon",
			);
		});

		test("uses npm for an npm project", async () => {
			writeFileSync(join(project, "package-lock.json"), "");

			const result = await handleGettingStartedPhase({
				agent: "claude",
				cwd: project,
				hasConnectionString: false,
				orm: "drizzle",
			});

			expect(result.nextAction.type).toBe("agent_action");
			if (result.nextAction.type !== "agent_action") return;
			const commandOf = (id: string) =>
				result.nextAction.type === "agent_action"
					? result.nextAction.steps.find((s) => s.id === id)?.command
					: undefined;

			expect(commandOf("install_dependencies")).toBe("npm install");
			expect(commandOf("install_driver")).toBe(
				"npm install @neondatabase/serverless",
			);
		});
	});

	test("always includes verify_connection step", async () => {
		const result = await handleGettingStartedPhase({
			agent: "claude",
			hasConnectionString: true,
		});

		if (result.nextAction.type === "agent_action") {
			const stepIds = result.nextAction.steps.map((s) => s.id);
			expect(stepIds).toContain("verify_connection");
			const verifyStep = result.nextAction.steps.find(
				(s) => s.id === "verify_connection",
			);
			expect(verifyStep?.description).toContain(
				"direct database connection",
			);
		}
	});
});
