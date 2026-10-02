import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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

		expect(projectDir(web)).toBe(web);
		await expect(loadProjectConfig({ cwd: web })).rejects.toThrow(
			`Could not find a Neon config file in ${web}.`,
		);
	});

	test("is the directory holding the nearest .neon", async () => {
		writeFileSync(join(root, ".neon"), "{}\n");
		writeFileSync(join(root, "neon.ts"), POLICY);

		expect(projectDir(web)).toBe(root);
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

		expect(resolveEnvFilePath(web)).toBe(join(root, ".env.local"));
		writeFileSync(join(root, ".env"), "");
		expect(resolveEnvFilePath(web)).toBe(join(root, ".env"));
		expect(resolveEnvFilePath(web, ".env.dev")).toBe(join(web, ".env.dev"));
	});
});
