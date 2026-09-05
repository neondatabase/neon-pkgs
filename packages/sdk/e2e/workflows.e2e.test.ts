import { describe, expect } from "vitest";
import {
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	expectOk,
	makeClient,
	uniqueProjectName,
} from "./helpers.js";

/**
 * The behaviours here are the ones the unit suite structurally cannot check, because it
 * answers every request with a canned `fetch` response: readiness polling against real
 * operation state, cursor pagination against cursors the API actually issues, and
 * connection strings resolved from a real project's branches, roles, and databases.
 */
describe.sequential("e2e — @neon/sdk workflows against the real API", () => {
	e2eTest(
		"createAndConnect waits for readiness and returns a usable connection string",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;
			const neon = makeClient();

			const created = expectOk(
				await neon.projects.createAndConnect({
					name: uniqueProjectName("sdk"),
					regionId: DEFAULT_REGION,
				}),
			);
			track(created.project.id);

			expect(created.connectionString).toMatch(/^postgresql:\/\//);
			// Default is the pooled string, which Neon serves from a distinct `-pooler` host.
			expect(created.connectionString).toContain("-pooler.");

			// Readiness polling is the point: the project must be usable, not merely created.
			const project = expectOk(
				await neon.projects.get(created.project.id),
			);
			expect(project.id).toBe(created.project.id);
		},
	);

	e2eTest(
		"the org default on the client scopes project creation",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;
			const orgId = process.env.NEON_ORG_ID?.trim();
			if (!orgId) return;
			const neon = makeClient();

			const project = expectOk(
				await neon.projects.create({
					name: uniqueProjectName("sdk-org"),
					regionId: DEFAULT_REGION,
				}),
			);
			track(project.id);

			expect(project.org_id).toBe(orgId);
		},
	);

	e2eTest(
		"branches.list walks real cursors across pages",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;
			const neon = makeClient();

			// create waits by default so the branch create below does not race the
			// project's own provisioning operations.
			const project = expectOk(
				await neon.projects.create({
					name: uniqueProjectName("sdk-page"),
					regionId: DEFAULT_REGION,
				}),
			);
			track(project.id);

			const main = expectOk(await neon.branches.getDefault(project.id));
			expectOk(
				await neon.branches.create(project.id, {
					name: "dev",
					parent_id: main.id,
					noCompute: true,
				}),
			);

			// `limit: 1` forces a genuine multi-page walk over two branches. Worth pinning
			// down because the cursor field differs per endpoint — branches paginate on
			// `pagination.next` while projects use `pagination.cursor`, and a stubbed
			// response can only ever confirm whichever one the stub was written with.
			const all = expectOk(
				await neon.branches.list(project.id, { limit: 1 }).all(),
			);
			expect(all.map((branch) => branch.name).sort()).toStrictEqual([
				"dev",
				main.name,
			]);

			const streamed: string[] = [];
			for await (const branch of neon.branches.list(project.id, {
				limit: 1,
			})) {
				streamed.push(branch.name);
			}
			expect(streamed.sort()).toStrictEqual(["dev", main.name]);
		},
	);

	e2eTest(
		"postgres.connectionString resolves branch, role and database on its own",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;
			const neon = makeClient();

			const project = expectOk(
				await neon.projects.create({
					name: uniqueProjectName("sdk-conn"),
					regionId: DEFAULT_REGION,
				}),
			);
			track(project.id);

			// Only the project id — everything else is auto-selected from the real project.
			const pooled = expectOk(
				await neon.postgres.connectionString({ projectId: project.id }),
			);
			const direct = expectOk(
				await neon.postgres.connectionString({
					projectId: project.id,
					pooled: false,
				}),
			);

			expect(pooled).toMatch(/^postgresql:\/\//);
			expect(direct).toMatch(/^postgresql:\/\//);
			expect(pooled).toContain("-pooler.");
			expect(direct).not.toContain("-pooler.");
		},
	);
});
