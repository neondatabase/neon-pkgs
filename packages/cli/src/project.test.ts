import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyPolicyOnCreate } from "./commands/config";
import { resolveEnvFilePath } from "./env_file";
import { loadProjectConfig, projectDir } from "./project";

const CONFIG_SRC = new URL("../../config/src/v1.ts", import.meta.url).pathname;
const POLICY = `import { defineConfig } from "${CONFIG_SRC}";
export default defineConfig({});
`;

describe("project directory", () => {
	let root: string;
	let web: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "neon-project-"));
		web = join(root, "apps", "web");
		mkdirSync(web, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("is cwd when no .neon exists, so a parent's neon.ts never loads", async () => {
		writeFileSync(
			join(root, "neon.ts"),
			'throw new Error("parent neon.ts loaded");\n',
		);

		expect(projectDir({ cwd: web })).toBe(web);
		await expect(loadProjectConfig({ cwd: web })).rejects.toThrow(
			`Could not find a Neon config file in ${web}.`,
		);
	});

	test("is the directory holding the nearest .neon", async () => {
		writeFileSync(join(root, ".neon"), "{}\n");
		writeFileSync(join(root, "neon.ts"), POLICY);

		expect(projectDir({ cwd: web })).toBe(root);
		const { resolvedPath } = await loadProjectConfig({ cwd: web });
		expect(resolvedPath).toBe(join(root, "neon.ts"));
	});

	test("does not look above the directory holding .neon", async () => {
		writeFileSync(join(web, ".neon"), "{}\n");
		writeFileSync(join(root, "neon.ts"), POLICY);

		await expect(loadProjectConfig({ cwd: web })).rejects.toThrow(
			`Could not find a Neon config file in ${web}.`,
		);
	});

	test("follows an explicit --context-file over the nearest .neon", async () => {
		writeFileSync(join(root, ".neon"), "{}\n");
		writeFileSync(join(root, "neon.ts"), POLICY);
		writeFileSync(join(web, "selected.json"), "{}\n");
		writeFileSync(join(web, "neon.ts"), POLICY);

		const location = { cwd: web, contextFile: "selected.json" };
		expect(projectDir(location)).toBe(web);
		const { resolvedPath } = await loadProjectConfig(location);
		expect(resolvedPath).toBe(join(web, "neon.ts"));
		expect(resolveEnvFilePath(location)).toBe(join(web, ".env.local"));
	});

	test("a branch-create policy comes from the --context-file project, not cwd's", async () => {
		writeFileSync(join(root, ".neon"), "{}\n");
		writeFileSync(
			join(root, "neon.ts"),
			'throw new Error("cwd project neon.ts loaded");\n',
		);
		const other = join(root, "..", `${basename(root)}-other`);
		mkdirSync(other);
		writeFileSync(join(other, ".neon"), "{}\n");

		try {
			await expect(
				applyPolicyOnCreate({
					projectId: "p",
					branchId: "br",
					cwd: root,
					contextFile: join(other, ".neon"),
				}),
			).resolves.toBeUndefined();
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	test("an explicit path wins over the project's neon.ts", async () => {
		writeFileSync(join(root, "other.ts"), POLICY);

		const { resolvedPath } = await loadProjectConfig({
			cwd: web,
			path: join(root, "other.ts"),
		});
		expect(resolvedPath).toBe(join(root, "other.ts"));
	});

	test("holds the default .env.local; an explicit --file stays relative to cwd", () => {
		writeFileSync(join(root, ".neon"), "{}\n");

		expect(resolveEnvFilePath({ cwd: web })).toBe(join(root, ".env.local"));
		writeFileSync(join(root, ".env"), "");
		expect(resolveEnvFilePath({ cwd: web })).toBe(join(root, ".env"));
		expect(resolveEnvFilePath({ cwd: web }, ".env.dev")).toBe(
			join(web, ".env.dev"),
		);
	});
});
