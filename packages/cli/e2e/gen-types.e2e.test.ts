import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect } from "vitest";
import { parseConnectionUri } from "../src/psql/index.js";
import { PgConnection } from "../src/psql/wire/connection.js";
import {
	createProject,
	e2eTest,
	runCli,
	uniqueProjectName,
} from "./helpers.js";

const TABLE = "gen_types_notes";

describe.sequential("e2e — data-api gen-types against the real API", () => {
	e2eTest(
		"introspects a table on the resolved branch connection",
		async ({ track }) => {
			const projectId = await createProject({
				name: uniqueProjectName("cli-gen-types"),
			});
			track(projectId);

			const uriResult = await runCli(
				["connection-string", "--project-id", projectId],
				{ json: false },
			);
			if (uriResult.code !== 0) {
				throw new Error(
					`connection-string exited ${uriResult.code}\n${uriResult.stderr}`,
				);
			}
			const session = await PgConnection.connect(
				parseConnectionUri(uriResult.stdout.trim()),
			);
			try {
				await session.query(
					`CREATE TABLE ${TABLE} (id int, body text)`,
				);
			} finally {
				await session.close();
			}

			const dir = mkdtempSync(path.join(tmpdir(), "gen-types-e2e-"));
			try {
				const outFile = path.join(dir, "database.types.ts");
				const result = await runCli(
					[
						"data-api",
						"gen-types",
						"--project-id",
						projectId,
						"--out-file",
						outFile,
					],
					{ json: false },
				);
				expect(result.code, result.stderr).toBe(0);

				const types = readFileSync(outFile, "utf8");
				expect(types).toContain(`${TABLE}: {`);
				expect(types).toContain("body: string | null");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
