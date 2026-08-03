import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "@neon/config";
import { loadConfigFromFile } from "@neon/config-runtime";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { test } from "../test_utils/fixtures";
import { hasNeonConfigFile, initCmd } from "./config";

describe("config init", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "neonctl-config-init-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test("creates a starter neon.ts when the project has none", async () => {
		await initCmd({ cwd: workspace, install: false });

		const content = readFileSync(join(workspace, "neon.ts"), "utf8");
		expect(content).toContain(
			'import { defineConfig } from "@neon/config/v1"',
		);
		expect(content).toContain("export default defineConfig({");
		expect(content).toContain("auth: false");
		expect(content).toContain('ttl: "7d"');
	});

	test("leaves an existing Neon config file untouched", async () => {
		const original = "export default { auth: true };\n";
		writeFileSync(join(workspace, "neon.ts"), original);

		await initCmd({ cwd: workspace, install: false });

		expect(readFileSync(join(workspace, "neon.ts"), "utf8")).toBe(original);
	});

	test("installs the missing config packages with the detected package manager", async () => {
		const calls: { cmd: string; args: string[]; cwd: string }[] = [];

		await initCmd({
			cwd: workspace,
			install: true,
			run: (cmd, args, cwd) => {
				calls.push({ cmd, args, cwd });
				return Promise.resolve(true);
			},
		});

		expect(calls).toHaveLength(1);
		// npm spells it `install`, pnpm/yarn/bun use `add` — assert on the packages,
		// which are the same regardless of the resolved package manager.
		expect(calls[0].args).toEqual(
			expect.arrayContaining(["@neon/config", "@neon/env"]),
		);
		expect(calls[0].cwd).toBe(workspace);
	});

	test("only installs the packages that aren't already declared", async () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({
				dependencies: { "@neon/config": "^0.8.1" },
			}),
		);
		const calls: string[][] = [];

		await initCmd({
			cwd: workspace,
			install: true,
			run: (_cmd, args) => {
				calls.push(args);
				return Promise.resolve(true);
			},
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("@neon/env");
		expect(calls[0]).not.toContain("@neon/config");
	});

	test("does nothing to install when both packages are already declared", async () => {
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({
				dependencies: {
					"@neon/config": "^0.8.1",
					"@neon/env": "^0.8.1",
				},
			}),
		);
		const calls: string[][] = [];

		await initCmd({
			cwd: workspace,
			run: (_cmd, args) => {
				calls.push(args);
				return Promise.resolve(true);
			},
		});

		expect(calls).toHaveLength(0);
	});

	test("--no-install scaffolds but never runs an installer", async () => {
		const calls: string[][] = [];

		await initCmd({
			cwd: workspace,
			install: false,
			run: (_cmd, args) => {
				calls.push(args);
				return Promise.resolve(true);
			},
		});

		expect(calls).toHaveLength(0);
		expect(existsSync(join(workspace, "neon.ts"))).toBe(true);
	});

	test("--services declares the selected services and scaffolds the function source", async () => {
		await initCmd({
			cwd: workspace,
			install: false,
			services: "auth,functions",
		});

		const content = readFileSync(join(workspace, "neon.ts"), "utf8");
		expect(content).toContain("auth: true");
		expect(content).toContain(
			'hello: { name: "Hello World", source: "./hello.ts" }',
		);
		expect(content).not.toContain("aiGateway");
		expect(readFileSync(join(workspace, "hello.ts"), "utf8")).toBe(
			`export default async function hello(): Promise<Response> {
  return new Response("Hello from Neon Functions");
}
`,
		);
	});

	test("--services storage declares the bucket with its default visibility", async () => {
		await initCmd({ cwd: workspace, install: false, services: "storage" });

		const content = readFileSync(join(workspace, "neon.ts"), "utf8");
		expect(content).toContain('assets: { access: "private" }');
		// Object storage needs no source file, unlike functions.
		expect(existsSync(join(workspace, "hello.ts"))).toBe(false);
	});

	test("--services none writes the same file as a non-interactive run", async () => {
		const bare = mkdtempSync(join(tmpdir(), "neonctl-config-init-bare-"));
		try {
			await initCmd({ cwd: workspace, install: false, services: "none" });
			await initCmd({ cwd: bare, install: false });

			expect(readFileSync(join(workspace, "neon.ts"), "utf8")).toBe(
				readFileSync(join(bare, "neon.ts"), "utf8"),
			);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	test("an unknown service fails before anything is written", async () => {
		await expect(
			initCmd({
				cwd: workspace,
				install: false,
				services: "auth,vectors",
			}),
		).rejects.toThrow(/Unknown service vectors/);

		expect(existsSync(join(workspace, "neon.ts"))).toBe(false);
	});

	test("the picker chooses the services when --services is omitted", async () => {
		await initCmd({
			cwd: workspace,
			install: false,
			pickServices: () => Promise.resolve(["ai-gateway"]),
		});

		const content = readFileSync(join(workspace, "neon.ts"), "utf8");
		expect(content).toContain("aiGateway: true");
		expect(content).toContain("auth: false");
	});

	test("an empty selection falls back to the starter policy", async () => {
		await initCmd({
			cwd: workspace,
			install: false,
			pickServices: () => Promise.resolve([]),
		});

		const content = readFileSync(join(workspace, "neon.ts"), "utf8");
		expect(content).toContain("auth: false");
		expect(content).not.toContain("preview");
	});

	test("never prompts when the project already has a neon.ts", async () => {
		writeFileSync(join(workspace, "neon.ts"), "export default {};\n");
		let picked = 0;

		await initCmd({
			cwd: workspace,
			install: false,
			pickServices: () => {
				picked += 1;
				return Promise.resolve(["auth"]);
			},
		});

		expect(picked).toBe(0);
	});

	test("leaves an existing hello.ts untouched", async () => {
		const original = "export default { async fetch() {} };\n";
		writeFileSync(join(workspace, "hello.ts"), original);

		await initCmd({
			cwd: workspace,
			install: false,
			services: "functions",
		});

		expect(readFileSync(join(workspace, "hello.ts"), "utf8")).toBe(
			original,
		);
		expect(readFileSync(join(workspace, "neon.ts"), "utf8")).toContain(
			'source: "./hello.ts"',
		);
	});

	// A scaffold that renders the right string but doesn't *load* is still broken:
	// `defineConfig` validates at module-eval time, so an unknown key or a bad function slug
	// only surfaces when `config plan` imports the file. Scaffold each variant for real and
	// load it through the same loader the CLI uses.
	//
	// The temp project lives under the package's own `node_modules` so jiti resolves
	// `@neon/config/v1` by walking up exactly as it would in a user's project — and so a
	// directory left behind by a crashed run can never be committed.
	test("every scaffolded policy loads and resolves", async () => {
		const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
		const cases: { services: string; expected: Record<string, unknown> }[] =
			[
				{
					services: "none",
					expected: {
						authEnabled: false,
						aiGateway: false,
						functions: [],
						buckets: [],
					},
				},
				{
					services: "auth",
					expected: {
						authEnabled: true,
						aiGateway: false,
						functions: [],
						buckets: [],
					},
				},
				{
					services: "auth,ai-gateway,functions,storage",
					expected: {
						authEnabled: true,
						aiGateway: true,
						functions: ["hello:./hello.ts"],
						buckets: ["assets:private"],
					},
				},
			];

		for (const { services, expected } of cases) {
			const project = mkdtempSync(
				join(packageRoot, "node_modules", ".neon-config-init-"),
			);
			try {
				await initCmd({ cwd: project, install: false, services });

				const { config } = await loadConfigFromFile({
					path: join(project, "neon.ts"),
				});
				const resolved = resolveConfig(config, {
					name: "dev",
					exists: false,
					isDefault: false,
				});

				expect({
					authEnabled: resolved.authEnabled,
					aiGateway: resolved.preview?.aiGatewayEnabled ?? false,
					functions: (resolved.preview?.functions ?? []).map(
						(fn) => `${fn.slug}:${fn.source}`,
					),
					buckets: (resolved.preview?.buckets ?? []).map(
						(bucket) => `${bucket.name}:${bucket.access}`,
					),
				}).toEqual(expected);
				// The starter policy's branch closure is part of what has to survive loading.
				expect(resolved.ttlSeconds).toBe(7 * 24 * 60 * 60);
			} finally {
				rmSync(project, { recursive: true, force: true });
			}
		}
	});

	test("hasNeonConfigFile detects each supported config filename", () => {
		expect(hasNeonConfigFile(workspace)).toBe(false);
		for (const name of ["neon.ts", "neon.mts", "neon.js", "neon.mjs"]) {
			rmSync(join(workspace, "neon.ts"), { force: true });
			rmSync(join(workspace, name), { force: true });
			writeFileSync(join(workspace, name), "export default {};\n");
			expect(hasNeonConfigFile(workspace)).toBe(true);
			rmSync(join(workspace, name), { force: true });
		}
		expect(hasNeonConfigFile(workspace)).toBe(false);
	});

	// End-to-end: `config init` must run with NO auth and NO network — it only
	// scaffolds locally. Pointing the CLI at an unreachable host proves that
	// neither the global auth middleware nor `fillSingleProject` reached out (a
	// regression in either offline guard would turn this into a connection error).
	test("runs offline end to end and scaffolds into the working directory", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["config", "init", "--no-install"], {
			unreachableHost: true,
			code: 0,
			cwd: workspace,
		});

		const content = readFileSync(join(workspace, "neon.ts"), "utf8");
		expect(content).toContain("@neon/config/v1");
	});

	// `--services` must reach the scaffolder through yargs, and must stay offline:
	// selecting the AI Gateway does not check the account's plan (init has no API client).
	test("--services runs offline end to end", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"config",
				"init",
				"--no-install",
				"--services",
				"ai-gateway,storage",
			],
			{ unreachableHost: true, code: 0, cwd: workspace },
		);

		const content = readFileSync(join(workspace, "neon.ts"), "utf8");
		expect(content).toContain("aiGateway: true");
		expect(content).toContain('assets: { access: "private" }');
	});
});
