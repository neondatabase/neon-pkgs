import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { projectConsoleUrl } from "./open.js";

const workspaces: string[] = [];

afterEach(() => {
	for (const workspace of workspaces.splice(0)) {
		rmSync(workspace, { recursive: true, force: true });
	}
});

describe("open", () => {
	test("builds the Console URL for the linked project", () => {
		expect(projectConsoleUrl("quiet-frog-12345678")).toBe(
			"https://console.neon.tech/app/projects/quiet-frog-12345678",
		);
	});

	test("encodes a project id before placing it in the URL", () => {
		expect(projectConsoleUrl("project/with spaces")).toBe(
			"https://console.neon.tech/app/projects/project%2Fwith%20spaces",
		);
	});

	test("bare open reaches the handler without authenticating", () => {
		const workspace = mkdtempSync(join(tmpdir(), "neon-open-"));
		workspaces.push(workspace);

		const result = spawnSync(
			process.execPath,
			[
				resolve(process.cwd(), "dist/cli.js"),
				"--config-dir",
				join(workspace, "config"),
				"--context-file",
				join(workspace, ".neon"),
				"--no-analytics",
				"open",
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					CI: "1",
					NEON_API_KEY: "",
					NEON_PROFILE: "",
				},
			},
		);

		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("No Neon project linked");
		expect(result.stderr).toContain("`neon link`");
		expect(result.stderr).not.toContain(
			"Cannot run interactive auth in CI",
		);
	});
});
