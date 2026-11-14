// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are template placeholders, not JavaScript templates.
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../log";
import {
	parseTemplateAgentTooling,
	type TemplateAgentTooling,
	type TemplateMcpServer,
} from "./agent_tooling";
import {
	ADD_MCP_PACKAGE,
	addMcpArgs,
	addMcpRetry,
	type RunTemplateToolingOptions,
	runTemplateTooling,
	selectTemplateTooling,
	systemCliHint,
	type TemplateToolingEntry,
	type TemplateToolingOperations,
	templateToolingChildEnv,
	templateToolingEntries,
} from "./agent_tooling_run";

const remote = (headers: Record<string, string> = {}): TemplateMcpServer => ({
	kind: "remote",
	name: "context7",
	recommended: true,
	url: "https://mcp.context7.com/mcp",
	transport: "http",
	headers,
});

const stdio: TemplateMcpServer = {
	kind: "stdio",
	name: "stripe",
	recommended: true,
	command: ["npx", "-y", "@stripe/mcp", "--tools=all", "has space"],
	env: { STRIPE_SECRET_KEY: "${STRIPE_SECRET_KEY}" },
};

const tooling: TemplateAgentTooling = parseTemplateAgentTooling({
	skills: [{ source: "vercel/ai", skills: ["ai-sdk"] }],
	mcp: [
		{ name: "context7", url: "https://mcp.context7.com/mcp" },
		{ name: "exa", url: "https://mcp.exa.ai/mcp", recommended: false },
	],
	cli: [{ name: "inngest", npm: "inngest-cli@1.4.2" }],
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "neon-template-tooling-"));
	vi.spyOn(log, "info").mockImplementation(() => {});
	vi.spyOn(log, "warning").mockImplementation(() => {});
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const fakeOps = <T extends Partial<TemplateToolingOperations>>(
	overrides: T = {} as T,
) => ({
	runSkills: vi.fn<TemplateToolingOperations["runSkills"]>(async () => ({})),
	runAddMcp: vi.fn<TemplateToolingOperations["runAddMcp"]>(async () => ({
		ok: true,
	})),
	install: vi.fn<TemplateToolingOperations["install"]>(async () => ({
		ok: true,
	})),
	probe: vi.fn<TemplateToolingOperations["probe"]>(() => ({ found: false })),
	askSecret: vi.fn<TemplateToolingOperations["askSecret"]>(
		async () => undefined,
	),
	pick: vi.fn<TemplateToolingOperations["pick"]>(async () => undefined),
	...overrides,
});

const run = (
	entries: TemplateToolingEntry[],
	options: Partial<RunTemplateToolingOptions> = {},
) =>
	runTemplateTooling({
		entries,
		trust: "neon",
		cwd: dir,
		agents: ["cursor"],
		interactive: false,
		packageManager: "pnpm",
		installPackages: true,
		env: {},
		...options,
	});

describe("ADD_MCP_PACKAGE", () => {
	it("pins the add-mcp version the CLI depends on", () => {
		const pkg = JSON.parse(
			readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
		) as { dependencies: Record<string, string> };
		expect(ADD_MCP_PACKAGE).toBe(`add-mcp@${pkg.dependencies["add-mcp"]}`);
	});
});

describe("selectTemplateTooling", () => {
	const base = {
		tooling,
		origin: "neondatabase/examples",
		yes: false,
		interactive: false,
	};
	const recommendedNames = (entries: TemplateToolingEntry[]) =>
		entries.map((entry) =>
			entry.kind === "skills" ? entry.item.source : entry.item.name,
		);

	it("installs nothing with --no-template-tooling, even in a terminal", async () => {
		const pick = vi.fn();
		expect(
			await selectTemplateTooling({
				...base,
				trust: "neon",
				flag: false,
				interactive: true,
				pick,
			}),
		).toEqual([]);
		expect(pick).not.toHaveBeenCalled();
	});

	it("installs the recommended entries with --template-tooling, whoever publishes them", async () => {
		for (const trust of ["neon", "third-party"] as const) {
			expect(
				recommendedNames(
					await selectTemplateTooling({ ...base, trust, flag: true }),
				),
			).toEqual(["vercel/ai", "context7", "inngest"]);
		}
	});

	it("lets -y install a Neon template's recommended entries but not a third party's", async () => {
		expect(
			recommendedNames(
				await selectTemplateTooling({
					...base,
					trust: "neon",
					yes: true,
				}),
			),
		).toEqual(["vercel/ai", "context7", "inngest"]);
		expect(
			await selectTemplateTooling({
				...base,
				trust: "third-party",
				origin: "acme/templates",
				yes: true,
			}),
		).toEqual([]);
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("Pass --template-tooling"),
			"acme/templates",
		);
	});

	it("asks in a terminal, preselecting only a Neon template's recommended entries", async () => {
		const pick = vi.fn<TemplateToolingOperations["pick"]>(
			async (entries) => [...entries],
		);
		await selectTemplateTooling({
			...base,
			trust: "neon",
			interactive: true,
			pick,
		});
		expect(pick.mock.calls[0]?.[1]).toEqual([true, true, false, true]);
		await selectTemplateTooling({
			...base,
			trust: "third-party",
			interactive: true,
			pick,
		});
		expect(pick.mock.calls[1]?.[1]).toEqual([false, false, false, false]);
		expect(log.warning).toHaveBeenCalledWith(
			expect.stringContaining("Neon has not reviewed it"),
			"neondatabase/examples",
		);
	});

	it("treats a cancelled picker as nothing selected", async () => {
		expect(
			await selectTemplateTooling({
				...base,
				trust: "neon",
				interactive: true,
				pick: async () => undefined,
			}),
		).toEqual([]);
	});
});

describe("addMcpArgs", () => {
	it("passes a remote server's URL, transport, and headers", () => {
		expect(
			addMcpArgs(
				remote({ Authorization: "Bearer ${T}" }),
				["cursor", "claude-code"],
				(raw) => raw.replace("${T}", "secret"),
			),
		).toEqual([
			"-y",
			ADD_MCP_PACKAGE,
			"https://mcp.context7.com/mcp",
			"--name",
			"context7",
			"-t",
			"http",
			"-a",
			"cursor",
			"-a",
			"claude-code",
			"--header",
			"Authorization: Bearer secret",
			"-y",
		]);
	});

	it("keeps add-mcp from splitting a stdio command's arguments", () => {
		expect(addMcpArgs(stdio, ["cursor"], () => "sk")).toEqual([
			"-y",
			ADD_MCP_PACKAGE,
			"npx -y",
			"--name",
			"stripe",
			"--args",
			"@stripe/mcp",
			"--args",
			"--tools=all",
			"--args",
			"has space",
			"-a",
			"cursor",
			"--env",
			"STRIPE_SECRET_KEY=sk",
			"-y",
		]);
	});

	it("prints a retry the shell can run without seeing a secret", () => {
		expect(addMcpRetry(stdio, ["cursor"])).toBe(
			`npx -y ${ADD_MCP_PACKAGE} 'npx -y' --name stripe --args @stripe/mcp --args --tools=all --args 'has space' -a cursor --env STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" -y`,
		);
	});
});

describe("templateToolingChildEnv", () => {
	it("drops Neon credentials and stops git from prompting", () => {
		const env = templateToolingChildEnv({
			PATH: "/bin",
			NEON_API_KEY: "napi_x",
			neon_api_key: "napi_y",
			NEON_ORG_ID: "org",
			DO_NOT_TRACK: "1",
		});
		expect(env).toEqual({ PATH: "/bin", GIT_TERMINAL_PROMPT: "0" });
	});
});

describe("runTemplateTooling skills", () => {
	const skills = templateToolingEntries(
		parseTemplateAgentTooling({
			skills: [{ source: "vercel/ai", skills: ["ai-sdk"] }],
		}),
	);

	it("installs project skills for the selected agents, mapped to skills CLI names", async () => {
		const ops = fakeOps();
		const report = await run(skills, {
			agents: ["cursor", "vscode", "github-copilot-cli"],
			env: { PATH: "/bin", NEON_API_KEY: "napi_x" },
			operations: ops,
		});
		const call = ops.runSkills.mock.calls[0]?.[0];
		if (call === undefined) throw new Error("skills CLI was not run");
		expect(call.args.slice(0, 10)).toEqual([
			"-y",
			"skills@latest",
			"add",
			"vercel/ai",
			"--skill",
			"ai-sdk",
			"--agent",
			"cursor",
			"--agent",
			"github-copilot",
		]);
		expect(call.args).not.toContain("-g");
		expect(call.env.NEON_API_KEY).toBeUndefined();
		expect(call.env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(report.rows).toEqual([
			{
				kind: "skills",
				name: "ai-sdk from vercel/ai",
				agents: "cursor, github-copilot",
				status: "installed",
			},
		]);
	});

	it("skips without an agent and reports a failure with the command to retry", async () => {
		const none = await run(skills, { agents: [], operations: fakeOps() });
		expect(none.rows[0]).toMatchObject({
			status: "skipped",
			detail: "no coding agent",
		});
		expect(none.next).toEqual([
			"npx -y skills@latest add vercel/ai --skill ai-sdk",
		]);

		const failed = await run(skills, {
			operations: fakeOps({
				runSkills: async () => {
					throw new Error("skills CLI failed:\nclone failed");
				},
			}),
		});
		expect(failed.rows[0]).toMatchObject({
			status: "failed",
			detail: "skills CLI failed:",
		});
		expect(failed.next).toEqual([
			"npx -y skills@latest add vercel/ai --skill ai-sdk --agent cursor -y",
		]);
	});
});

describe("runTemplateTooling MCP servers", () => {
	const entry = (server: TemplateMcpServer): TemplateToolingEntry[] => [
		{ kind: "mcp", item: server },
	];
	const secretServer = remote({
		Authorization: "Bearer ${CONTEXT7_API_KEY}",
	});
	const writeCursorConfig = async (options: { args: readonly string[] }) => {
		mkdirSync(join(dir, ".cursor"), { recursive: true });
		writeFileSync(
			join(dir, ".cursor", "mcp.json"),
			JSON.stringify({ args: options.args }),
		);
		return { ok: true as const };
	};

	it("fills a Neon template's placeholder from the environment and locks the config down", async () => {
		const ops = fakeOps({ runAddMcp: vi.fn(writeCursorConfig) });
		const report = await run(entry(secretServer), {
			env: { CONTEXT7_API_KEY: "ctx7sk-1" },
			operations: ops,
		});
		const args = ops.runAddMcp.mock.calls[0]?.[0].args;
		expect(args).toContain("Authorization: Bearer ctx7sk-1");
		expect(report.rows[0]).toMatchObject({
			status: "installed",
			agents: "Cursor",
		});
		expect(statSync(join(dir, ".cursor", "mcp.json")).mode & 0o777).toBe(
			0o600,
		);
		expect(readFileSync(join(dir, ".cursor", ".gitignore"), "utf8")).toBe(
			"mcp.json\n",
		);
	});

	it("reads a Neon template's placeholder from the project .env", async () => {
		writeFileSync(join(dir, ".env"), "CONTEXT7_API_KEY=from-file\n");
		const ops = fakeOps();
		await run(entry(secretServer), {
			envFile: join(dir, ".env"),
			operations: ops,
		});
		expect(ops.runAddMcp.mock.calls[0]?.[0].args).toContain(
			"Authorization: Bearer from-file",
		);
	});

	it("never copies a Neon or cloud credential from the environment", async () => {
		const ops = fakeOps();
		const report = await run(
			entry(remote({ Authorization: "Bearer ${NEON_API_KEY}" })),
			{ env: { NEON_API_KEY: "napi_secret" }, operations: ops },
		);
		expect(ops.runAddMcp).not.toHaveBeenCalled();
		expect(report.rows[0]).toMatchObject({
			status: "skipped",
			detail: "needs NEON_API_KEY",
		});
		expect(report.next.join("\n")).not.toContain("napi_secret");
		expect(report.next[0]).toContain(
			`'Authorization: Bearer '"$NEON_API_KEY"`,
		);
	});

	it("fills a third-party template's placeholder only from a prompt", async () => {
		writeFileSync(join(dir, ".env"), "CONTEXT7_API_KEY=from-file\n");
		const quiet = fakeOps();
		const skipped = await run(entry(secretServer), {
			trust: "third-party",
			env: { CONTEXT7_API_KEY: "from-env" },
			envFile: join(dir, ".env"),
			operations: quiet,
		});
		expect(quiet.runAddMcp).not.toHaveBeenCalled();
		expect(skipped.rows[0]).toMatchObject({ status: "skipped" });

		const asked = fakeOps({ askSecret: vi.fn(async () => "typed") });
		await run(entry(secretServer), {
			trust: "third-party",
			interactive: true,
			env: { CONTEXT7_API_KEY: "from-env" },
			envFile: join(dir, ".env"),
			operations: asked,
		});
		expect(asked.askSecret).toHaveBeenCalledWith(
			expect.stringContaining(
				"CONTEXT7_API_KEY for the context7 MCP server (mcp.context7.com)",
			),
		);
		expect(asked.runAddMcp.mock.calls[0]?.[0].args).toContain(
			"Authorization: Bearer typed",
		);
	});

	it("leaves an existing server of the same name alone", async () => {
		mkdirSync(join(dir, ".cursor"));
		writeFileSync(
			join(dir, ".cursor", "mcp.json"),
			JSON.stringify({
				mcpServers: { Context7: { url: "https://mine" } },
			}),
		);
		const ops = fakeOps();
		const report = await run(entry(remote()), { operations: ops });
		expect(ops.runAddMcp).not.toHaveBeenCalled();
		expect(report.rows[0]).toMatchObject({
			status: "skipped",
			detail: "already configured",
		});
	});

	it("skips agents without a project-level config for the transport", async () => {
		const ops = fakeOps();
		const report = await run(entry(remote()), {
			agents: ["claude-desktop"],
			operations: ops,
		});
		expect(ops.runAddMcp).not.toHaveBeenCalled();
		expect(report.rows[0]?.detail).toMatch(/no selected agent takes/);
	});

	it("will not write a secret into a config git tracks", async () => {
		execFileSync("git", ["init", "-q", dir]);
		mkdirSync(join(dir, ".cursor"));
		writeFileSync(join(dir, ".cursor", "mcp.json"), "{}\n");
		execFileSync("git", ["-C", dir, "add", ".cursor/mcp.json"]);
		const ops = fakeOps();
		const report = await run(entry(secretServer), {
			env: { CONTEXT7_API_KEY: "ctx7sk-1" },
			operations: ops,
		});
		expect(ops.runAddMcp).not.toHaveBeenCalled();
		expect(report.rows[0]).toMatchObject({
			status: "skipped",
			detail: "config tracked by git",
		});
	});

	it("redacts the secret from a failure", async () => {
		const report = await run(entry(secretServer), {
			env: { CONTEXT7_API_KEY: "ctx7sk-1" },
			operations: fakeOps({
				runAddMcp: async () => ({
					ok: false,
					detail: "bad header Authorization: Bearer ctx7sk-1",
				}),
			}),
		});
		expect(report.rows[0]).toMatchObject({
			status: "failed",
			detail: "bad header Authorization: Bearer [redacted]",
		});
		expect(report.next.join("\n")).not.toContain("ctx7sk-1");
	});
});

describe("runTemplateTooling CLIs", () => {
	const clis = templateToolingEntries(
		parseTemplateAgentTooling({
			cli: [
				{ name: "inngest", npm: "inngest-cli@1.4.2" },
				{
					name: "stripe",
					minVersion: "1.21.0",
					install: { brew: "stripe/stripe-cli/stripe" },
				},
			],
		}),
	);

	it("adds npm CLIs as exact devDependencies once dependencies are installed", async () => {
		const ops = fakeOps();
		const report = await run(clis, { operations: ops });
		expect(ops.install).toHaveBeenCalledWith(
			"pnpm",
			["add", "-D", "-E", "inngest-cli@1.4.2"],
			dir,
		);
		expect(report.rows[0]).toMatchObject({
			name: "inngest",
			status: "installed",
		});
	});

	it("leaves npm CLIs in next steps when dependencies were not installed", async () => {
		const ops = fakeOps();
		const report = await run(clis, {
			installPackages: false,
			operations: ops,
		});
		expect(ops.install).not.toHaveBeenCalled();
		expect(report.rows[0]).toMatchObject({
			status: "skipped",
			detail: "dependencies not installed",
		});
		expect(report.next).toContain("pnpm add -D -E inngest-cli@1.4.2");
	});

	it("checks system CLIs and only prints how to install them", async () => {
		const missing = await run(clis, { operations: fakeOps() });
		expect(missing.rows[1]).toMatchObject({
			name: "stripe",
			status: "skipped",
			detail: "not on PATH",
		});
		expect(missing.next).toContain(
			`Install stripe: ${systemCliHint({
				kind: "system",
				name: "stripe",
				recommended: true,
				install: { brew: "stripe/stripe-cli/stripe" },
			})}`,
		);

		const old = await run(clis, {
			operations: fakeOps({
				probe: () => ({ found: true, version: "1.20.9" }),
			}),
		});
		expect(old.rows[1]).toMatchObject({
			status: "skipped",
			detail: "1.20.9 is older than 1.21.0",
		});

		const found = await run(clis, {
			operations: fakeOps({
				probe: () => ({ found: true, version: "1.30.0" }),
			}),
		});
		expect(found.rows[1]).toMatchObject({
			status: "found",
			detail: "1.30.0",
		});
	});

	it("orders install hints for the platform", () => {
		const cli = {
			kind: "system" as const,
			name: "x",
			recommended: true,
			install: {
				brew: "x",
				winget: "Acme.X",
				url: "https://x.dev/install",
			},
		};
		expect(systemCliHint(cli, "darwin")).toBe(
			"brew install x or winget install --id Acme.X -e or https://x.dev/install",
		);
		expect(systemCliHint(cli, "win32")).toBe(
			"winget install --id Acme.X -e or brew install x or https://x.dev/install",
		);
	});
});
