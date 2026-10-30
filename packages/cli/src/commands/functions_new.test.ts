import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "@neon/config-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderNeonConfig } from "../config_template";
import { openRegistry, type Registry } from "../functions/source";
import { FIXTURE_REGISTRY_DIR } from "../test_utils/registry";
import {
	formatNewFunctionDone,
	type ScaffoldFromTemplateOptions,
	scaffoldFromTemplate,
} from "./functions_new";

const MAILER_ENV_EXAMPLE = "# API key for the mailer.\nMAILER_API_KEY=\n";

describe("functions new", () => {
	let workspace: string;
	let registry: Registry;

	beforeEach(async () => {
		workspace = mkdtempSync(join(tmpdir(), "neon-functions-new-"));
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));
		registry = await openRegistry({
			kind: "dir",
			dir: FIXTURE_REGISTRY_DIR,
		});
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	const read = (path: string) => readFileSync(join(workspace, path), "utf8");
	const run = (
		options: Omit<ScaffoldFromTemplateOptions, "registry" | "interactive">,
	) =>
		scaffoldFromTemplate({
			cwd: workspace,
			registry,
			interactive: false,
			install: false,
			...options,
		});

	it("scaffolds a router template as one function", async () => {
		const result = await run({
			template: "notes",
			operations: ["list", "health"],
		});

		expect(result).toMatchObject({
			cancelled: false,
			layout: "router",
			routes: ["/list", "/health"],
			functions: [{ slug: "notes", source: "functions/notes/index.ts" }],
			config: { path: "neon.ts", action: "updated" },
		});
		expect(read("functions/notes/list.ts")).toBe(
			readFileSync(
				join(FIXTURE_REGISTRY_DIR, "notes/functions/list.ts"),
				"utf8",
			),
		);
		expect(existsSync(join(workspace, "functions/notes/get.ts"))).toBe(
			false,
		);
		const router = read("functions/notes/index.ts");
		expect(router).toContain('import op0 from "./list";');
		expect(router).toContain('"/health": op1,');
		expect(read("neon.ts")).toContain(
			'notes: { name: "Notes API", source: "./functions/notes/index.ts" }',
		);
	});

	it("uses the recommended operations and an operation's own route", async () => {
		const result = await run({ template: "notes" });

		expect(result).toMatchObject({ routes: ["/list", "/note"] });
		expect(existsSync(join(workspace, "functions/notes/health.ts"))).toBe(
			false,
		);
	});

	it("scaffolds a separate template as one function per recommended operation", async () => {
		const result = await run({ template: "mailer" });

		expect(result).toMatchObject({
			environment: ["MAILER_API_KEY"],
			dependencies: ["mailer-sdk@1.2.3"],
			installed: false,
		});
		expect(result.cancelled === false && result.nextSteps[0]).toMatch(
			/Install the template's dependencies: `.* -E mailer-sdk@1\.2\.3`/,
		);
		const config = read("neon.ts");
		for (const [slug, id] of [
			["mailsend", "send"],
			["mailget", "get"],
		]) {
			expect(config).toContain(`${slug}: {`);
			expect(config).toContain(`source: "./functions/mailer/${id}.ts"`);
		}
		expect(config).not.toContain("mailcancel");
		expect(existsSync(join(workspace, "functions/mailer/index.ts"))).toBe(
			false,
		);
	});

	it("declares the template's env in neon.ts and lists it in .env.example", async () => {
		await run({ template: "mailer", operations: ["send"] });

		expect(read("neon.ts")).toContain(
			"env: { MAILER_API_KEY: process.env.MAILER_API_KEY! }",
		);
		expect(read(".env.example")).toBe(MAILER_ENV_EXAMPLE);
		expect(existsSync(join(workspace, ".env.local"))).toBe(false);
	});

	it("appends to an existing .env.example without repeating a name", async () => {
		writeFileSync(join(workspace, ".env.example"), "DATABASE_URL=");
		const expected = `DATABASE_URL=\n\n${MAILER_ENV_EXAMPLE}`;

		const first = await run({ template: "mailer", operations: ["send"] });
		expect(read(".env.example")).toBe(expected);
		expect(first).toMatchObject({
			envExample: { path: ".env.example", added: ["MAILER_API_KEY"] },
		});

		const second = await run({
			template: "mailer",
			operations: ["cancel"],
			slug: "mailer2",
		});
		expect(read(".env.example")).toBe(expected);
		expect(second).not.toHaveProperty("envExample");
	});

	it("points deploy at the env file and notes that dev loads it automatically", async () => {
		const result = await run({ template: "mailer", operations: ["send"] });

		expect(result.cancelled === false && result.nextSteps).toEqual(
			expect.arrayContaining([
				"Set MAILER_API_KEY (API key for the mailer.) in .env.local (`neon dev` loads it automatically).",
				"Next: `neon dev` to run it locally, `neon config apply --env .env.local` to deploy.",
			]),
		);
	});

	it("writes a neon.ts that loads with the env set and names it when unset", async () => {
		const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
		const project = mkdtempSync(
			join(packageRoot, "node_modules", ".neon-functions-new-"),
		);
		const previous = process.env.MAILER_API_KEY;
		try {
			writeFileSync(join(project, "neon.ts"), renderNeonConfig([]));
			await run({
				template: "mailer",
				operations: ["send"],
				cwd: project,
			});

			process.env.MAILER_API_KEY = "key_test";
			const { config } = await loadConfigFromFile({
				path: join(project, "neon.ts"),
			});
			expect(config.functions?.mailsend?.env).toEqual({
				MAILER_API_KEY: "key_test",
			});

			delete process.env.MAILER_API_KEY;
			await expect(
				loadConfigFromFile({ path: join(project, "neon.ts") }),
			).rejects.toThrow(/MAILER_API_KEY/);
		} finally {
			if (previous === undefined) delete process.env.MAILER_API_KEY;
			else process.env.MAILER_API_KEY = previous;
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("copies a template without operations to index.ts", async () => {
		await run({ template: "hello", addToConfig: false });

		expect(read("functions/hello/index.ts")).toBe(
			readFileSync(
				join(FIXTURE_REGISTRY_DIR, "hello/functions/index.ts"),
				"utf8",
			),
		);
		expect(read("neon.ts")).toBe(renderNeonConfig([]));
	});

	it("refuses to overwrite a differing file without --force", async () => {
		mkdirSync(join(workspace, "functions/hello"), { recursive: true });
		writeFileSync(join(workspace, "functions/hello/index.ts"), "mine\n");

		await expect(run({ template: "hello" })).rejects.toThrow(/--force/);
		expect(read("functions/hello/index.ts")).toBe("mine\n");
		expect(read("neon.ts")).toBe(renderNeonConfig([]));
	});

	it("refuses a slug neon.ts already declares, before writing anything", async () => {
		await run({ template: "hello" });
		rmSync(join(workspace, "functions"), { recursive: true });

		await expect(run({ template: "hello" })).rejects.toThrow(
			/already declares hello/,
		);
		expect(existsSync(join(workspace, "functions"))).toBe(false);
	});

	it("does not suggest --slug when a separate template's slugs are declared", async () => {
		await run({ template: "mailer", operations: ["send"] });
		rmSync(join(workspace, "functions"), { recursive: true });

		const error = await run({
			template: "mailer",
			operations: ["send"],
			slug: "mailer2",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(
			/already declares mailsend\. The template sets these slugs/,
		);
		expect((error as Error).message).not.toContain("Pass --slug");
	});

	it("rejects an invalid --slug before reading the template", async () => {
		const load = vi.spyOn(registry, "load");

		await expect(
			run({ template: "hello", slug: "my-hello" }),
		).rejects.toThrow(
			'"my-hello" is not a valid function slug: use 1-20 lowercase letters and digits, no hyphens. Try "myhello".',
		);
		expect(load).not.toHaveBeenCalled();
	});

	it("summarises a scaffold in the bootstrap layout", async () => {
		const result = await run({ template: "hello", addToConfig: false });
		if (result.cancelled) throw new Error("unexpected cancel");

		expect(formatNewFunctionDone(result)).toBe(
			[
				"Function created.",
				"-----------------",
				"",
				"  Template   Hello (Neon)",
				"  Function   hello",
				"  Directory  functions/hello",
				"  Config     not added",
				"",
				"Next:",
				"  neon dev --source functions/hello/index.ts",
				"  neon functions deploy hello --src functions/hello/index.ts",
				"",
			].join("\n"),
		);
	});

	it("summarises dependencies, env and config without repeating Next:", async () => {
		const result = await run({ template: "mailer" });
		if (result.cancelled) throw new Error("unexpected cancel");
		const text = formatNewFunctionDone(result);

		expect(text).toMatch(/^Functions created\.\n-{18}\n/);
		expect(text).toContain("  Functions     mailsend, mailget\n");
		expect(text).toContain(
			"  Config        neon.ts updated: added functions.mailsend, added functions.mailget\n",
		);
		expect(text).toContain("  Dependencies  not installed\n");
		expect(text).toContain(
			"  Env           MAILER_API_KEY added to .env.example\n",
		);
		expect(text.match(/Next:/g)).toHaveLength(1);
		expect(text).not.toContain("`");
		expect(text).toMatch(
			/Next:\n {2}.*mailer-sdk@1\.2\.3\n {2}Set MAILER_API_KEY in \.env\.local \(neon dev loads it automatically\)\n {2}neon dev\n {2}neon config apply --env \.env\.local\n$/,
		);
	});

	it("leaves installs to Next: without a terminal, even when it creates neon.ts", async () => {
		rmSync(join(workspace, "neon.ts"));
		const calls: string[][] = [];
		const result = await run({
			template: "hello",
			install: undefined,
			run: async (_pm, args) => {
				calls.push(args);
				return true;
			},
		});
		if (result.cancelled) throw new Error("unexpected cancel");

		expect(calls).toEqual([]);
		expect(result.install).toBe("skipped");
		expect(result.next[0]).toMatch(/@neon\/config @neon\/env$/);
		expect(formatNewFunctionDone(result)).toContain(
			"  Dependencies  not installed\n",
		);
	});

	it("installs the config packages and the template's dependencies when asked", async () => {
		rmSync(join(workspace, "neon.ts"));
		const calls: string[][] = [];
		const result = await run({
			template: "mailer",
			operations: ["send"],
			install: true,
			run: async (_pm, args) => {
				calls.push(args);
				writeFileSync(
					join(workspace, "package.json"),
					JSON.stringify({
						dependencies: { "@neon/config": "*", "@neon/env": "*" },
					}),
				);
				return true;
			},
		});
		if (result.cancelled) throw new Error("unexpected cancel");

		const configInstall = calls.find((args) =>
			args.includes("@neon/config"),
		);
		const templateInstall = calls.find((args) =>
			args.includes("mailer-sdk@1.2.3"),
		);
		expect(configInstall).not.toContain("-E");
		expect(templateInstall).toContain("-E");
		expect(calls.flat()).toEqual(
			expect.arrayContaining([
				"@neon/config",
				"@neon/env",
				"mailer-sdk@1.2.3",
			]),
		);
		expect(result.install).toBe("installed");
		expect(result.packages).toEqual([
			"@neon/config",
			"@neon/env",
			"mailer-sdk@1.2.3",
		]);
		expect(result.next.join("\n")).not.toMatch(/install|add /);
		const text = formatNewFunctionDone(result);
		expect(text.startsWith("Function created.\n")).toBe(true);
		expect(text).toContain(
			`  Dependencies  installed with ${result.packageManager}\n`,
		);
	});

	it("rejects an unknown operation and an unknown template", async () => {
		await expect(
			run({ template: "mailer", operations: ["nope"] }),
		).rejects.toThrow(/Unknown operation "nope"/);
		await expect(run({ template: "nope" })).rejects.toThrow(
			/Available templates: hello, notes, mailer/,
		);
	});
});
