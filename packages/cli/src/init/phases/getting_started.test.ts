import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeProjectDir } from "../../test_utils/project_dir.js";

vi.mock("../skills.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ensureSkillsUpToDate: vi.fn().mockResolvedValue(true) };
});

import { handleGettingStartedPhase } from "./getting_started.js";

describe("getting-started phase", () => {
	// Every case runs against a real project directory rather than the repo it is
	// being tested from, so no assertion depends on this checkout's lockfile.
	let project: ReturnType<typeof makeProjectDir>;

	beforeEach(() => {
		project = makeProjectDir("npm");
	});

	afterEach(() => {
		project.cleanup();
	});

	test("returns agent_action with getting-started prerequisite", async () => {
		const result = await handleGettingStartedPhase({
			agent: "claude",
			cwd: project.dir,
		});

		expect(result.phase).toBe("setup");
		expect(result.status).toBe("getting_started");
		expect(result.nextAction.type).toBe("agent_action");

		if (result.nextAction.type === "agent_action") {
			expect(result.nextAction.prerequisite).toContain(
				"backend-overview.md",
			);
			expect(result.nextAction.onComplete.type).toBe("run_neon_init");
		}
	});

	test("includes org selection, project selection, and connection string steps when no connection string", async () => {
		const result = await handleGettingStartedPhase({
			agent: "claude",
			cwd: project.dir,
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
			cwd: project.dir,
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
			cwd: project.dir,
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
			cwd: project.dir,
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
			cwd: project.dir,
			hasConnectionString: true,
			migrationTool: "prisma",
		});

		if (result.nextAction.type === "agent_action") {
			const stepIds = result.nextAction.steps.map((s) => s.id);
			expect(stepIds).toContain("run_migrations");
			const migrationStep = result.nextAction.steps.find(
				(s) => s.id === "run_migrations",
			);
			expect(migrationStep?.command).toBe(
				"npx --no prisma migrate deploy",
			);
		}
	});

	test("includes knex migration command", async () => {
		const result = await handleGettingStartedPhase({
			agent: "claude",
			cwd: project.dir,
			hasConnectionString: true,
			migrationTool: "knex",
		});

		if (result.nextAction.type === "agent_action") {
			const migrationStep = result.nextAction.steps.find(
				(s) => s.id === "run_migrations",
			);
			expect(migrationStep?.command).toBe("npx --no knex migrate:latest");
		}
	});

	describe("install commands follow the project's package manager", () => {
		test.each([
			[
				"pnpm",
				"pnpm install",
				"pnpm add @neondatabase/serverless @prisma/adapter-neon",
			],
			[
				"yarn",
				"yarn install",
				"yarn add @neondatabase/serverless @prisma/adapter-neon",
			],
			[
				"bun",
				"bun install",
				"bun add @neondatabase/serverless @prisma/adapter-neon",
			],
			[
				"npm",
				"npm install",
				"npm install @neondatabase/serverless @prisma/adapter-neon",
			],
		] as const)("a %s project gets %s", async (pm, expectedInstall, expectedDriver) => {
			const { dir, cleanup } = makeProjectDir(pm);
			try {
				const result = await handleGettingStartedPhase({
					agent: "claude",
					cwd: dir,
					hasConnectionString: false,
					orm: "prisma",
				});

				expect(result.nextAction.type).toBe("agent_action");
				if (result.nextAction.type !== "agent_action") return;
				const steps = result.nextAction.steps;
				const commandOf = (id: string) =>
					steps.find((s) => s.id === id)?.command;

				expect(commandOf("install_dependencies")).toBe(expectedInstall);
				expect(commandOf("install_driver")).toBe(expectedDriver);
			} finally {
				cleanup();
			}
		});

		test("the drizzle driver install follows the project too", async () => {
			const { dir, cleanup } = makeProjectDir("bun");
			try {
				const result = await handleGettingStartedPhase({
					agent: "claude",
					cwd: dir,
					hasConnectionString: false,
					orm: "drizzle",
				});

				expect(result.nextAction.type).toBe("agent_action");
				if (result.nextAction.type !== "agent_action") return;
				const driver = result.nextAction.steps.find(
					(s) => s.id === "install_driver",
				);
				expect(driver?.command).toBe(
					"bun add @neondatabase/serverless",
				);
			} finally {
				cleanup();
			}
		});
	});

	test("always includes verify_connection step", async () => {
		const result = await handleGettingStartedPhase({
			agent: "claude",
			cwd: project.dir,
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
