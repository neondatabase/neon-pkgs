import {
	configuredBaseUrl,
	createProject,
	deleteProject,
	requireApiKey,
	uniqueProjectName,
} from "@neon/e2e-harness";
import { createNeonClient, NeonNotFoundError } from "@neon/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNeonTools } from "../src/index.js";
import { holdingOutputContract } from "./output-contract.js";

describe.sequential("e2e — @neon/tools Data API tools", () => {
	const neon = createNeonClient({
		apiKey: requireApiKey(),
		baseUrl: configuredBaseUrl(),
		throwOnError: true,
	});
	const tools = holdingOutputContract(
		createNeonTools({
			apiKey: requireApiKey(),
			baseUrl: configuredBaseUrl(),
			tools: ["postgres.dataApi.get", "postgres.dataApi.create"],
		}),
	);
	let projectId: string;
	let branchId: string;

	beforeAll(async () => {
		projectId = await createProject({
			name: uniqueProjectName("tools-data-api"),
		});
		branchId = (await neon.branches.getDefault({ projectId })).id;
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
	});

	it("postgres.dataApi.get returns enabled false before the Data API is created", async () => {
		const { data } = await tools["postgres.dataApi.get"].execute({
			project_id: projectId,
			branch_id: branchId,
			database_name: "neondb",
		});
		expect(data).toEqual({ enabled: false });
	});

	it("postgres.dataApi.get still throws for a database or branch that does not exist", async () => {
		const missingDatabase = tools["postgres.dataApi.get"].execute({
			project_id: projectId,
			branch_id: branchId,
			database_name: "no_such_database",
		});
		await expect(missingDatabase).rejects.toBeInstanceOf(NeonNotFoundError);
		await expect(missingDatabase).rejects.toMatchObject({
			status: 404,
			message: "database not found",
		});

		const missingBranch = tools["postgres.dataApi.get"].execute({
			project_id: projectId,
			branch_id: "br-does-not-exist-00000000",
			database_name: "neondb",
		});
		await expect(missingBranch).rejects.toMatchObject({
			status: 404,
			message: "branch not found",
		});
	});

	it("postgres.dataApi.get returns enabled true and the URL postgres.dataApi.create returned", async () => {
		const ids = {
			project_id: projectId,
			branch_id: branchId,
			database_name: "neondb",
		};
		const { data: created } =
			await tools["postgres.dataApi.create"].execute(ids);

		const { data } = await tools["postgres.dataApi.get"].execute(ids);

		expect(data).toMatchObject({ enabled: true, url: created.url });
	});
});
