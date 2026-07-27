import { describe, expect } from "vitest";
import {
	e2eTest,
	orgArgs,
	runCli,
	runCliJson,
	uniqueProjectName,
} from "./helpers.js";

/** `projects create` wraps the project; `get` and `delete` print it bare. */
type CreatedProject = {
	project: { id: string; name: string; org_id?: string };
};
type BareProject = {
	id: string;
	name: string;
};

/**
 * The full lifecycle a user actually runs, through the real binary against the real API.
 * The CLI's own unit tests answer every request from a local emocks fixture server, so
 * they verify argument plumbing and output formatting but never that a command still
 * works against Neon.
 */
describe.sequential("e2e — neon CLI projects against the real API", () => {
	e2eTest(
		"creates, reads, lists and deletes a project",
		async ({ track }) => {
			const name = uniqueProjectName("cli");

			const created = await runCliJson<CreatedProject>([
				"projects",
				"create",
				"--name",
				name,
				"--region-id",
				"aws-us-east-2",
				...orgArgs(),
			]);
			const projectId = created.project.id;
			track(projectId);
			expect(created.project.name).toBe(name);

			const fetched = await runCliJson<BareProject>([
				"projects",
				"get",
				projectId,
			]);
			expect(fetched.id).toBe(projectId);

			const listed = await runCliJson<BareProject[]>([
				"projects",
				"list",
				...orgArgs(),
			]);
			expect(listed.map((project) => project.id)).toContain(projectId);

			const deleted = await runCliJson<BareProject>([
				"projects",
				"delete",
				projectId,
			]);
			expect(deleted.id).toBe(projectId);

			const afterDelete = await runCli(["projects", "get", projectId]);
			expect(afterDelete.code).not.toBe(0);
		},
	);

	e2eTest(
		"prints a human-readable table when asked for one",
		async ({ track }) => {
			const name = uniqueProjectName("cli-table");
			const created = await runCliJson<CreatedProject>([
				"projects",
				"create",
				"--name",
				name,
				"--region-id",
				"aws-us-east-2",
				...orgArgs(),
			]);
			track(created.project.id);

			const table = await runCli(["projects", "list", ...orgArgs()], {
				json: false,
			});

			expect(table.code).toBe(0);
			expect(table.stdout).toContain(name);
			expect(table.stdout.trimStart().startsWith("{")).toBe(false);
		},
	);

	e2eTest(
		"exits non-zero with a readable error for a missing project",
		async () => {
			// Scripts branch on the exit code. A CLI that reports failure on stdout while
			// exiting 0 breaks them silently, so this pins both halves.
			const result = await runCli([
				"projects",
				"get",
				"definitely-not-a-project",
			]);

			expect(result.code).not.toBe(0);
			expect(`${result.stderr}${result.stdout}`).toMatch(
				/not found|404/i,
			);
		},
	);
});
