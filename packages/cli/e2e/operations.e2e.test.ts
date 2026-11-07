import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCliJson,
	uniqueProjectName,
} from "./helpers.js";

type Operation = { id: string; action: string; status: string };

describe.sequential("e2e — neon operations against the real API", () => {
	let projectId: string;

	beforeAll(async () => {
		projectId = await createProject({ name: uniqueProjectName("cli-ops") });
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
	});

	it("gets an operation the list returned", async () => {
		const operations = await runCliJson<Operation[]>([
			"operations",
			"list",
			"--project-id",
			projectId,
		]);
		expect(operations.length).toBeGreaterThan(0);

		const listed = operations[0];
		const fetched = await runCliJson<Operation>([
			"operations",
			"get",
			listed.id,
			"--project-id",
			projectId,
		]);
		expect(fetched).toMatchObject({
			id: listed.id,
			action: listed.action,
		});
	});
});
