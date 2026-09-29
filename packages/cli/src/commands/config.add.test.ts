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
import { resolveConfig } from "@neon/config";
import { loadConfigFromFile } from "@neon/config-runtime";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { renderNeonConfig } from "../config_template";
import { test } from "../test_utils/fixtures";
import { addCmd } from "./config";

describe("config add", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "neonctl-config-add-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	const read = (name: string) => readFileSync(join(workspace, name), "utf8");

	test("add function declares the function and writes its handler", async () => {
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));

		await addCmd({
			cwd: workspace,
			target: { kind: "function", slug: "sendemail", name: "Send Email" },
		});

		expect(read("neon.ts")).toContain(
			'sendemail: { name: "Send Email", source: "./functions/sendemail.ts" }',
		);
		expect(read("functions/sendemail.ts")).toBe(
			`export default async function sendemail(): Promise<Response> {
  return new Response("Hello from Neon Functions");
}
`,
		);
	});

	test("add function leaves an existing handler untouched", async () => {
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));
		mkdirSync(join(workspace, "functions"));
		const original = "export default { async fetch() {} };\n";
		writeFileSync(join(workspace, "functions/sendemail.ts"), original);

		await addCmd({
			cwd: workspace,
			target: { kind: "function", slug: "sendemail" },
		});

		expect(read("functions/sendemail.ts")).toBe(original);
		expect(read("neon.ts")).toContain(
			'sendemail: { name: "sendemail", source: "./functions/sendemail.ts" }',
		);
	});

	test("add function follows the config file's language and an explicit --source", async () => {
		writeFileSync(
			join(workspace, "neon.mjs"),
			"export default {\n  auth: false,\n};\n",
		);

		await addCmd({
			cwd: workspace,
			target: { kind: "function", slug: "cron", source: "jobs/cron.js" },
		});

		expect(read("neon.mjs")).toContain('source: "./jobs/cron.js"');
		expect(read("jobs/cron.js")).toBe(
			`export default async function cron() {
  return new Response("Hello from Neon Functions");
}
`,
		);
	});

	test("names the handler `handler` when the slug is a reserved word", async () => {
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));

		await addCmd({
			cwd: workspace,
			target: { kind: "function", slug: "default" },
		});

		expect(read("functions/default.ts")).toContain(
			"export default async function handler()",
		);

		// Illegal as an ECMAScript module declaration name too.
		await addCmd({
			cwd: workspace,
			target: { kind: "function", slug: "eval" },
		});
		expect(read("functions/eval.ts")).toContain(
			"export default async function handler()",
		);
	});

	test("rejects __proto__ as a bucket name", async () => {
		const original = renderNeonConfig([]);
		writeFileSync(join(workspace, "neon.ts"), original);

		await expect(
			addCmd({
				cwd: workspace,
				target: { kind: "bucket", name: "__proto__" },
			}),
		).rejects.toThrow(/"__proto__" cannot be used as a bucket name/);

		expect(read("neon.ts")).toBe(original);
	});

	test("rejects a slug the platform would reject, before writing anything", async () => {
		const original = renderNeonConfig([]);
		writeFileSync(join(workspace, "neon.ts"), original);

		await expect(
			addCmd({
				cwd: workspace,
				target: { kind: "function", slug: "send-email" },
			}),
		).rejects.toThrow(/1-20 lowercase letters and digits.*Try "sendemail"/);

		expect(read("neon.ts")).toBe(original);
		expect(existsSync(join(workspace, "functions"))).toBe(false);
	});

	test("rejects a function that is already declared without touching its handler", async () => {
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));
		await addCmd({
			cwd: workspace,
			target: { kind: "function", slug: "sendemail" },
		});
		const declared = read("neon.ts");
		writeFileSync(join(workspace, "functions/sendemail.ts"), "// mine\n");

		await expect(
			addCmd({
				cwd: workspace,
				target: { kind: "function", slug: "sendemail", name: "Other" },
			}),
		).rejects.toThrow(/already declares function "sendemail"/);

		expect(read("neon.ts")).toBe(declared);
		expect(read("functions/sendemail.ts")).toBe("// mine\n");
	});

	test("add auth on an enabled project changes nothing", async () => {
		const original = renderNeonConfig(["auth"]);
		writeFileSync(join(workspace, "neon.ts"), original);

		await addCmd({
			cwd: workspace,
			target: { kind: "service", service: "auth" },
		});

		expect(read("neon.ts")).toBe(original);
	});

	test("edits the neon.ts found by walking up from a subdirectory", async () => {
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));
		const sub = join(workspace, "apps", "web");
		mkdirSync(sub, { recursive: true });

		await addCmd({
			cwd: sub,
			target: { kind: "function", slug: "hook" },
		});

		expect(read("neon.ts")).toContain("hook:");
		expect(existsSync(join(sub, "neon.ts"))).toBe(false);
		// The handler sits beside the neon.ts that references it, not beside cwd.
		expect(existsSync(join(workspace, "functions", "hook.ts"))).toBe(true);
	});

	test("--config edits the named file", async () => {
		writeFileSync(join(workspace, "other.ts"), renderNeonConfig([]));

		await addCmd({
			cwd: workspace,
			config: "other.ts",
			target: { kind: "service", service: "ai-gateway" },
		});

		expect(read("other.ts")).toContain("aiGateway: true");
		expect(existsSync(join(workspace, "neon.ts"))).toBe(false);
	});

	test("--config that does not exist is an error", async () => {
		await expect(
			addCmd({
				cwd: workspace,
				config: "missing.ts",
				target: { kind: "service", service: "auth" },
			}),
		).rejects.toThrow(/--config missing\.ts does not exist/);
	});

	test("creates neon.ts and installs the packages when the project has none", async () => {
		const calls: { args: string[]; cwd: string }[] = [];

		await addCmd({
			cwd: workspace,
			target: { kind: "service", service: "data-api" },
			run: (_cmd, args, cwd) => {
				calls.push({ args, cwd });
				return Promise.resolve(true);
			},
		});

		expect(read("neon.ts")).toContain("auth: true,\n  dataApi: true,");
		expect(read("neon.ts")).toContain("@neon/config/v1");
		expect(calls).toHaveLength(1);
		expect(calls[0].args).toEqual(
			expect.arrayContaining(["@neon/config", "@neon/env"]),
		);
	});

	test("does not install anything when it only edits an existing neon.ts", async () => {
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));
		const calls: string[][] = [];

		await addCmd({
			cwd: workspace,
			target: { kind: "service", service: "auth" },
			run: (_cmd, args) => {
				calls.push(args);
				return Promise.resolve(true);
			},
		});

		expect(calls).toHaveLength(0);
	});

	test("a layout it cannot edit is refused and the file is left as it was", async () => {
		const original = "export default defineConfig({ auth: false });\n";
		writeFileSync(join(workspace, "neon.ts"), original);

		await expect(
			addCmd({
				cwd: workspace,
				target: { kind: "function", slug: "sendemail" },
			}),
		).rejects.toThrow(/Declare it by hand:[\s\S]*sendemail:/);

		expect(read("neon.ts")).toBe(original);
		// A refused edit writes nothing.
		expect(existsSync(join(workspace, "functions"))).toBe(false);
	});

	// An edit that produces the right text but a file that doesn't load is still broken:
	// `defineConfig` validates at module-eval time. Run a sequence of adds on the starter
	// policy and load each result through the loader the CLI uses.
	//
	// The temp project lives under the package's own `node_modules` so the loader resolves
	// `@neon/config/v1` by walking up exactly as it would in a user's project.
	test("every edited policy loads and resolves", async () => {
		const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
		const project = mkdtempSync(
			join(packageRoot, "node_modules", ".neon-config-add-"),
		);
		try {
			writeFileSync(join(project, "neon.ts"), renderNeonConfig([]));
			const adds = [
				{ kind: "service", service: "data-api" },
				{ kind: "service", service: "ai-gateway" },
				{ kind: "function", slug: "sendemail" },
				{ kind: "function", slug: "cron", name: "Cron job" },
				{ kind: "bucket", name: "user-uploads", access: "public_read" },
				{ kind: "bucket", name: "assets" },
			] as const;
			for (const target of adds) {
				await addCmd({ cwd: project, target });
			}

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
				dataApiEnabled: resolved.dataApiEnabled,
				aiGateway: resolved.preview?.aiGatewayEnabled ?? false,
				functions: (resolved.preview?.functions ?? []).map(
					(fn) => `${fn.slug}:${fn.name}:${fn.source}`,
				),
				buckets: (resolved.preview?.buckets ?? []).map(
					(bucket) => `${bucket.name}:${bucket.access}`,
				),
			}).toEqual({
				authEnabled: true,
				dataApiEnabled: true,
				aiGateway: true,
				functions: [
					"sendemail:sendemail:./functions/sendemail.ts",
					"cron:Cron job:./functions/cron.ts",
				],
				buckets: ["user-uploads:public_read", "assets:private"],
			});
			// The starter policy's branch closure has to survive every edit.
			expect(resolved.ttlSeconds).toBe(7 * 24 * 60 * 60);
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	});

	// `config add` must run with NO auth and NO network, like `config init`. An unreachable
	// host proves neither the auth middleware nor the project resolver reached out.
	test("runs offline end to end", async ({ testCliCommand }) => {
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));

		const { stderr } = await testCliCommand(
			["config", "add", "function", "sendemail", "--name", "Send Email"],
			{ unreachableHost: true, code: 0, cwd: workspace, snapshot: false },
		);

		expect(read("neon.ts")).toContain('sendemail: { name: "Send Email"');
		expect(existsSync(join(workspace, "functions/sendemail.ts"))).toBe(
			true,
		);
		expect(stderr).toContain("Created functions/sendemail.ts");
		expect(stderr).toContain("Updated neon.ts: added functions.sendemail");
	});

	test("add bucket --access reaches the file through yargs", async ({
		testCliCommand,
	}) => {
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));

		await testCliCommand(
			["config", "add", "bucket", "avatars", "--access", "public_read"],
			{ unreachableHost: true, code: 0, cwd: workspace, snapshot: false },
		);

		expect(read("neon.ts")).toContain('avatars: { access: "public_read" }');
	});

	test("an invalid --access is refused by yargs", async ({
		testCliCommand,
	}) => {
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));

		const { stderr } = await testCliCommand(
			["config", "add", "bucket", "avatars", "--access", "public"],
			{ unreachableHost: true, code: 1, cwd: workspace, snapshot: false },
		);

		expect(stderr).toContain('"private", "public_read"');
		expect(read("neon.ts")).toBe(renderNeonConfig([]));
	});

	test("init --services on an existing neon.ts points at config add", async ({
		testCliCommand,
	}) => {
		writeFileSync(join(workspace, "neon.ts"), renderNeonConfig([]));

		const { stderr } = await testCliCommand(
			["config", "init", "--no-install", "--services", "auth"],
			{ unreachableHost: true, code: 0, cwd: workspace, snapshot: false },
		);

		expect(stderr).toContain("--services was ignored");
		expect(stderr).toContain("config add");
		expect(read("neon.ts")).toBe(renderNeonConfig([]));
	});
});
