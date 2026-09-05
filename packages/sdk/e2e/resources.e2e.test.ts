import {
	createProject,
	deleteProject,
	uniqueProjectName,
} from "@neon/e2e-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NeonClient } from "../src/index.js";
import { NeonNotFoundError } from "../src/index.js";
import { expectOk, makeClient } from "./helpers.js";

/**
 * The resource CRUD spine, exercised against one shared project. Creating a project per
 * test would triple the runtime for no extra signal — the fixtures they need (a default
 * branch, its endpoint, its role) come with any project.
 *
 * Mutations still serialize at the project. A call that returns before its operations
 * finish rejects the next one with "project already has running conflicting operations",
 * so every mutating call here waits (`waitForReadiness: true`, or a method default that
 * already waits).
 *
 * The project is created through the harness rather than the SDK so that a regression in
 * `projects.create` fails its own test in `workflows.e2e.test.ts` instead of taking the
 * whole file's setup down with it.
 */
describe.sequential("e2e — @neon/sdk resources against the real API", () => {
	let neon: NeonClient<false>;
	let projectId: string;
	let defaultBranchId: string;

	beforeAll(async () => {
		neon = makeClient();
		projectId = await createProject({ name: uniqueProjectName("sdk-res") });
		const main = expectOk(await neon.branches.getDefault(projectId));
		defaultBranchId = main.id;
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
	});

	it("round-trips a branch through create, get, update and delete", async () => {
		const created = expectOk(
			await neon.branches.create(projectId, {
				name: "crud",
				parent_id: defaultBranchId,
				noCompute: true,
			}),
		);
		expect(created.branch.name).toBe("crud");

		const fetched = expectOk(
			await neon.branches.get(projectId, created.branch.id),
		);
		expect(fetched.id).toBe(created.branch.id);

		const renamed = expectOk(
			await neon.branches.update(
				projectId,
				created.branch.id,
				{ name: "crud-renamed" },
				{ waitForReadiness: true },
			),
		);
		expect(renamed.name).toBe("crud-renamed");

		expectOk(
			await neon.branches.delete(projectId, created.branch.id, {
				waitForReadiness: true,
			}),
		);

		const { error } = await neon.branches.get(projectId, created.branch.id);
		expect(error).toBeInstanceOf(NeonNotFoundError);
	});

	it("compares schemas and resets a child back to its parent", async () => {
		const child = expectOk(
			await neon.branches.createAndConnect(projectId, {
				name: "reset-child",
				parentId: defaultBranchId,
			}),
		);
		const branchId = child.branch.id;
		const roles = expectOk(
			await neon.postgres.roles.list(projectId, branchId),
		);
		const owner = roles[0];
		if (!owner) throw new Error("child branch has no role");

		const matching = expectOk(
			await neon.branches.compareSchema(projectId, branchId, {
				databaseName: "neondb",
				baseBranchId: defaultBranchId,
			}),
		);
		expect(matching.diff ?? "").toBe("");

		expectOk(
			await neon.postgres.databases.create(
				projectId,
				branchId,
				{ name: "child_only", owner_name: owner.name },
				{ waitForReadiness: true },
			),
		);

		expectOk(
			await neon.branches.resetFromParent(
				projectId,
				branchId,
				undefined,
				{
					waitForReadiness: true,
				},
			),
		);
		const after = expectOk(
			await neon.postgres.databases.list(projectId, branchId),
		);
		expect(after.map((database) => database.name)).not.toContain(
			"child_only",
		);
		const matchingAgain = expectOk(
			await neon.branches.compareSchema(projectId, branchId, {
				databaseName: "neondb",
				baseBranchId: defaultBranchId,
			}),
		);
		expect(matchingAgain.diff ?? "").toBe("");

		expectOk(
			await neon.branches.delete(projectId, branchId, {
				waitForReadiness: true,
			}),
		);
	});

	it("creates a branch with its compute and a connection string in one call", async () => {
		const created = expectOk(
			await neon.branches.createAndConnect(projectId, {
				name: "with-compute",
				parentId: defaultBranchId,
			}),
		);

		expect(created.branch.name).toBe("with-compute");
		expect(created.endpoint.branch_id).toBe(created.branch.id);
		expect(created.connectionString).toMatch(/^postgresql:\/\//);

		// The endpoint the workflow reports must be the one the API actually attached.
		const endpoints = expectOk(
			await neon.postgres.endpoints.listByBranch(
				projectId,
				created.branch.id,
			),
		);
		expect(endpoints.map((endpoint) => endpoint.id)).toContain(
			created.endpoint.id,
		);

		expectOk(
			await neon.branches.delete(projectId, created.branch.id, {
				waitForReadiness: true,
			}),
		);
	});

	it("attaches a read-write endpoint unless noCompute is true", async () => {
		const withCompute = expectOk(
			await neon.branches.create(projectId, {
				name: "with-endpoint",
				parent_id: defaultBranchId,
			}),
		);
		expect(withCompute.endpoint?.type).toBe("read_write");
		expect(withCompute.connectionString).toMatch(/^postgres(ql)?:\/\//);
		const attached = expectOk(
			await neon.postgres.endpoints.listByBranch(
				projectId,
				withCompute.branch.id,
			),
		);
		expect(
			attached.filter((endpoint) => endpoint.type === "read_write"),
		).toHaveLength(1);

		const bare = expectOk(
			await neon.branches.create(projectId, {
				name: "bare",
				parent_id: defaultBranchId,
				noCompute: true,
			}),
		);
		expect(bare.endpoint).toBeUndefined();
		expect(bare.connectionString).toBeUndefined();
		const none = expectOk(
			await neon.postgres.endpoints.listByBranch(
				projectId,
				bare.branch.id,
			),
		);
		expect(none).toEqual([]);

		expectOk(
			await neon.branches.delete(projectId, withCompute.branch.id, {
				waitForReadiness: true,
			}),
		);
		expectOk(
			await neon.branches.delete(projectId, bare.branch.id, {
				waitForReadiness: true,
			}),
		);
	});

	it("manages roles, including the two different password shapes", async () => {
		const before = expectOk(
			await neon.postgres.roles.list(projectId, defaultBranchId),
		);
		expect(before.length).toBeGreaterThan(0);

		const created = expectOk(
			await neon.postgres.roles.create(
				projectId,
				defaultBranchId,
				{ name: "e2e_role" },
				{ waitForReadiness: true },
			),
		);
		expect(created.name).toBe("e2e_role");

		// `password` unwraps to a bare string, `resetPassword` returns the whole Role —
		// an asymmetry that's easy to break when the response mapping is touched.
		const password = expectOk(
			await neon.postgres.roles.password(
				projectId,
				defaultBranchId,
				"e2e_role",
			),
		);
		expect(typeof password).toBe("string");
		expect(password.length).toBeGreaterThan(0);

		const reset = expectOk(
			await neon.postgres.roles.resetPassword(
				projectId,
				defaultBranchId,
				"e2e_role",
				{ waitForReadiness: true },
			),
		);
		expect(reset.name).toBe("e2e_role");
		expect(reset.password).not.toBe(password);

		expectOk(
			await neon.postgres.roles.delete(
				projectId,
				defaultBranchId,
				"e2e_role",
				{ waitForReadiness: true },
			),
		);
		const after = expectOk(
			await neon.postgres.roles.list(projectId, defaultBranchId),
		);
		expect(after.map((role) => role.name)).not.toContain("e2e_role");
	});

	it("round-trips a database", async () => {
		const roles = expectOk(
			await neon.postgres.roles.list(projectId, defaultBranchId),
		);
		const owner = roles[0];
		if (!owner) throw new Error("project has no role to own a database");

		const created = expectOk(
			await neon.postgres.databases.create(
				projectId,
				defaultBranchId,
				{ name: "e2e_db", owner_name: owner.name },
				{ waitForReadiness: true },
			),
		);
		expect(created.name).toBe("e2e_db");

		const fetched = expectOk(
			await neon.postgres.databases.get(
				projectId,
				defaultBranchId,
				"e2e_db",
			),
		);
		expect(fetched.owner_name).toBe(owner.name);

		expectOk(
			await neon.postgres.databases.delete(
				projectId,
				defaultBranchId,
				"e2e_db",
				{ waitForReadiness: true },
			),
		);
		const after = expectOk(
			await neon.postgres.databases.list(projectId, defaultBranchId),
		);
		expect(after.map((db) => db.name)).not.toContain("e2e_db");
	});

	it("lists and fetches the default branch's endpoint", async () => {
		const all = expectOk(await neon.postgres.endpoints.list(projectId));
		const byBranch = expectOk(
			await neon.postgres.endpoints.listByBranch(
				projectId,
				defaultBranchId,
			),
		);
		expect(byBranch.length).toBeGreaterThan(0);
		expect(all.map((endpoint) => endpoint.id)).toEqual(
			expect.arrayContaining(byBranch.map((endpoint) => endpoint.id)),
		);

		const first = byBranch[0];
		if (!first) throw new Error("default branch has no endpoint");
		const fetched = expectOk(
			await neon.postgres.endpoints.get(projectId, first.id),
		);
		expect(fetched.id).toBe(first.id);
		expect(fetched.branch_id).toBe(defaultBranchId);
	});

	it("waitFor resolves against operations the project has already run", async () => {
		const operations = expectOk(
			await neon.operations.list(projectId).all(),
		);
		expect(operations.length).toBeGreaterThan(0);

		// Everything this project has done is finished by now, so waitFor must recognise
		// the terminal states and return rather than poll until the timeout.
		expectOk(await neon.operations.waitFor(operations.slice(0, 5)));

		const single = operations[0];
		if (!single) throw new Error("unreachable");
		const fetched = expectOk(
			await neon.operations.get(projectId, single.id),
		);
		expect(fetched.id).toBe(single.id);
	});
});
