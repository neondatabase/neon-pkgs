import { describe, expect, test } from "vitest";
import { handleDbPhase } from "./db.js";

describe("handleDbPhase", () => {
	test("starts by listing orgs when no args provided", async () => {
		const result = await handleDbPhase({});

		expect(result.phase).toBe("db");
		expect(result.status).toBe("ready");
		expect(result.nextAction.type).toBe("run_command");
		if (result.nextAction.type === "run_command") {
			expect(result.nextAction.command).toContain("neonctl orgs list");
			expect(result.nextAction.onSuccess.args).toContain("--orgs-result");
		}
	});

	test("selects single org and lists projects", async () => {
		const orgsResult = JSON.stringify([{ id: "org-abc", name: "My Org" }]);

		const result = await handleDbPhase({ orgsResult });

		expect(result.status).toBe("org_selected");
		expect(result.nextAction.type).toBe("run_command");
		if (result.nextAction.type === "run_command") {
			expect(result.nextAction.command).toContain("--org-id org-abc");
			expect(result.nextAction.command).toContain("projects list");
		}
	});

	test("asks user to choose org when multiple exist", async () => {
		const orgsResult = JSON.stringify([
			{ id: "org-1", name: "Org 1" },
			{ id: "org-2", name: "Org 2" },
		]);

		const result = await handleDbPhase({ orgsResult });

		expect(result.status).toBe("select_org");
		expect(result.nextAction.type).toBe("ask_user");
		if (result.nextAction.type === "ask_user") {
			expect(result.nextAction.options).toHaveLength(2);
			expect(result.nextAction.responseMapping).toHaveProperty("org-1");
			expect(result.nextAction.responseMapping).toHaveProperty("org-2");
		}
	});

	test("asks user to choose project from list", async () => {
		const projectsResult = JSON.stringify({
			projects: [
				{ id: "proj-1", name: "App 1" },
				{ id: "proj-2", name: "App 2" },
			],
		});

		const result = await handleDbPhase({ projectsResult, orgId: "org-1" });

		expect(result.status).toBe("select_project");
		expect(result.nextAction.type).toBe("ask_user");
		if (result.nextAction.type === "ask_user") {
			// 2 projects + "create new" option
			expect(result.nextAction.options).toHaveLength(3);
			expect(result.nextAction.responseMapping).toHaveProperty("proj-1");
			expect(result.nextAction.responseMapping).toHaveProperty(
				"create_new",
			);
		}
	});

	test("returns agent_action when project is selected", async () => {
		const result = await handleDbPhase({ projectId: "proj-xyz" });

		expect(result.status).toBe("project_ready");
		expect(result.nextAction.type).toBe("agent_action");
		if (result.nextAction.type === "agent_action") {
			expect(result.nextAction.steps).toHaveLength(3);
			expect(result.nextAction.steps[0].command).toContain("proj-xyz");
			expect(result.nextAction.prerequisite).toContain(
				"connection-methods",
			);
		}
	});

	test("handles empty projects list", async () => {
		const projectsResult = JSON.stringify({ projects: [] });

		const result = await handleDbPhase({ projectsResult });

		expect(result.status).toBe("no_projects");
		expect(result.nextAction.type).toBe("ask_user");
	});

	test("handles error from previous step", async () => {
		const result = await handleDbPhase({ error: "orgs-list-failed" });

		expect(result.status).toBe("error");
		expect(result.nextAction.type).toBe("ask_user");
	});

	test("rejects project ID with shell metacharacters", async () => {
		await expect(
			handleDbPhase({ projectId: "proj; rm -rf /" }),
		).rejects.toThrow("Invalid project ID");
	});

	test("rejects org ID with shell metacharacters", async () => {
		await expect(handleDbPhase({ orgId: "org$(whoami)" })).rejects.toThrow(
			"Invalid org ID",
		);
	});

	test("lists projects directly when org-id is provided without orgs-result", async () => {
		const result = await handleDbPhase({ orgId: "org-abc" });

		expect(result.status).toBe("org_selected");
		expect(result.nextAction.type).toBe("run_command");
		if (result.nextAction.type === "run_command") {
			expect(result.nextAction.command).toContain("--org-id org-abc");
		}
	});
});
