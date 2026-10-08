import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCredentialInputs } from "@neon-internals/cli-core/auth_selection";
import { type IPty, spawn as spawnPty } from "node-pty";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import yargs from "yargs";
import { takeCommandSuccessExtras } from "../analytics.js";
import {
	CLAIMABLE_ALREADY_LINKED,
	CLAIMABLE_MCP_API_KEY,
	INIT_NEEDS_YES,
	MCP_SCOPED_NEEDS_PROJECT,
	NO_AGENT_SETUP_CONFLICT,
	namedAgentsUnavailable,
} from "../init/copy.js";
import type { InitAgentSetup } from "../init/plan.js";
import type { AgentType } from "../mcp/agents.js";
import { test as cliTest } from "../test_utils/fixtures.js";
import { npmEnvForIsolatedHome } from "../test_utils/npm_env.js";
import { builder } from "./init.js";

vi.mock("../analytics.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../analytics.js")>();
	return {
		...actual,
		sendError: vi.fn(),
		trackEvent: vi.fn(),
		closeAnalytics: vi.fn(),
	};
});

const host = "https://console.neon.tech/api/v2";

/**
 * Fake plugins/skills/mcp install functions, injected via `props.operations` instead of a
 * spawned child process. `calls` records every invocation, in order, across all three, so
 * tests can assert on step ordering the same way they used to assert on spawned argv order.
 */
type OperationCall =
	| { kind: "plugins"; options: Record<string, unknown> }
	| { kind: "skills"; options: Record<string, unknown> }
	| { kind: "mcp"; options: Record<string, unknown> };

const makeOperations = () => {
	const calls: OperationCall[] = [];
	const installPlugins = vi.fn(async (options: Record<string, unknown>) => {
		calls.push({ kind: "plugins", options });
		return {
			scope: options.global ? "global" : "project",
			rows: [],
			failed: [] as never[],
		};
	});
	const installSkills = vi.fn(async (options: Record<string, unknown>) => {
		calls.push({ kind: "skills", options });
		return {
			scope: options.global ? "global" : "project",
			agents: (options.agents as string[] | undefined) ?? [],
			rows: [],
			failed: [] as never[],
		};
	});
	const installMcp = vi.fn(async (options: Record<string, unknown>) => {
		calls.push({ kind: "mcp", options });
		return {
			scope: options.project ? "project" : "global",
			rows: [],
			failedAgents: [] as string[],
			url: "https://mcp.neon.tech/mcp",
			auth: options.oauth ? ("oauth" as const) : ("api-key" as const),
		};
	});
	return { installPlugins, installSkills, installMcp, calls };
};

const stepKinds = (ops: ReturnType<typeof makeOperations>): string[] =>
	ops.calls.map((call) => call.kind);

const baseProps = (overrides: Record<string, unknown> = {}) => ({
	apiClient: {} as never,
	apiKey: "test-key",
	apiHost: host,
	output: "table" as const,
	contextFile: "/tmp/does-not-exist/.neon",
	linkProject: vi.fn().mockResolvedValue(undefined),
	initConfig: vi.fn().mockResolvedValue(undefined),
	envPull: vi.fn().mockResolvedValue({ status: "empty" }),
	hasLocalCredentials: () => true,
	detectInstalledAgents: async () => [],
	detectAgent: () => null,
	analytics: false,
	...overrides,
});

const stdoutText = (spy: { mock: { calls: unknown[][] } }): string =>
	spy.mock.calls.map((call) => String(call[0])).join("");

const waitForPtyText = (
	term: IPty,
	output: () => string,
	text: string,
): Promise<void> =>
	new Promise((resolve, reject) => {
		if (stripAnsi(output()).includes(text)) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			subscription.dispose();
			reject(
				new Error(
					`Timed out waiting for "${text}". Output:\n${stripAnsi(output())}`,
				),
			);
		}, 10_000);
		const subscription = term.onData(() => {
			if (!stripAnsi(output()).includes(text)) {
				return;
			}
			clearTimeout(timer);
			subscription.dispose();
			resolve();
		});
	});

const waitForPtyExit = (term: IPty): Promise<number> =>
	new Promise((resolve) => {
		term.onExit(({ exitCode }) => resolve(exitCode));
	});

const clearCredentialInputs = () =>
	recordCredentialInputs({
		apiKeyFlag: "",
		apiKeyEnv: "",
		profileEnv: "",
		profileFlag: "",
		configDir: "",
	});

const pickSkillsMcp = async (): Promise<InitAgentSetup> => "skills-mcp";

describe("init handler", () => {
	beforeEach(() => {
		vi.stubEnv("CI", "true");
	});

	afterEach(() => {
		takeCommandSuccessExtras();
		clearCredentialInputs();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		vi.resetModules();
	});

	test("empty directory without -y fails before children", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-"));
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					operations: ops,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(INIT_NEEDS_YES);
		expect(ops.calls).toEqual([]);
	});

	test("existing app without -y fails before children", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-ci-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					operations: ops,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(INIT_NEEDS_YES);
		expect(ops.calls).toEqual([]);
	});

	test("empty -y is Recommended in place: skills fallback, link, default neon.ts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-y-"));
		const ops = makeOperations();
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				contextFile: join(cwd, ".neon"),
				initConfig,
				linkProject,
			}),
		);

		expect(stepKinds(ops)).toEqual(["skills"]);
		expect(ops.calls[0]?.options).toMatchObject({
			yes: true,
			agents: ["cursor", "codex"],
		});
		expect(ops.calls[0]?.options.global).toBeFalsy();
		expect(linkProject).toHaveBeenCalled();
		expect(initConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd,
				install: true,
				services: ["postgres"],
			}),
		);
		expect(stdoutText(stdout)).toContain(
			"No coding agents detected. Installing the default Neon skills",
		);
		expect(stdoutText(stdout)).toContain("in this directory");
		expect(stdoutText(stdout)).not.toContain("user scope");
		expect(takeCommandSuccessExtras()).toEqual({
			init_kind: "empty-skip",
			agent_setup: "skills",
		});
	});

	test("--services postgres writes the starter neon.ts through config init", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-services-"));
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { initCmd } = await import("./config.js");
		const { renderNeonConfig } = await import("../config_template.js");
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				yes: true,
				services: ["postgres"],
				contextFile: join(cwd, ".neon"),
				initConfig: async (input: {
					cwd: string;
					services?: readonly string[];
				}) =>
					initCmd({
						cwd: input.cwd,
						install: false,
						silent: true,
						...(input.services ? { services: input.services } : {}),
					}),
			}),
		);

		expect(readFileSync(join(cwd, "neon.ts"), "utf8")).toBe(
			renderNeonConfig([]),
		);
	});

	test("--realtime is passed separately to config init", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-realtime-"));
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				yes: true,
				realtime: true,
				contextFile: join(cwd, ".neon"),
				initConfig,
			}),
		);

		expect(initConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				services: ["postgres"],
				realtime: true,
			}),
		);
	});

	test("empty -y without auth skips link and prints the next step", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-unauth-"));
		const ops = makeOperations();
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				contextFile: join(cwd, ".neon"),
				linkProject,
				hasLocalCredentials: () => false,
			}),
		);

		expect(linkProject).not.toHaveBeenCalled();
		const out = stdoutText(stdout);
		expect(out).toContain("Neon setup needs a next step.");
		expect(out).toContain("https://neon.com/signup");
		expect(out).toMatch(/neon login/);
		expect(out).toMatch(/neon link/);
		expect(out).toMatch(/neon claim create/);
	});

	test("Custom -y unanswered project setup skips link when unauthenticated", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-custom-unauth-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				agentSetup: false,
				config: false,
				linkProject,
				hasLocalCredentials: () => false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(linkProject).not.toHaveBeenCalled();
		expect(takeCommandSuccessExtras()).toEqual({
			init_kind: "existing",
			agent_setup: "skip",
		});
	});

	test("-y with org, project, and branch but no credentials writes .neon offline and neon.ts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-yes-offline-pin-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const envPull = vi.fn().mockResolvedValue({ status: "empty" });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				orgId: "org-example",
				projectId: "prj-example",
				branch: "br-example",
				services: ["auth"],
				linkProject,
				initConfig,
				envPull,
				hasLocalCredentials: () => false,
				detectProjectAgents: () => ["cursor"],
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(stepKinds(ops)).toEqual(["plugins"]);
		expect(linkProject).not.toHaveBeenCalled();
		expect(envPull).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(join(cwd, ".neon"), "utf8"))).toEqual({
			orgId: "org-example",
			projectId: "prj-example",
			branch: "br-example",
		});
		expect(initConfig).toHaveBeenCalledWith(
			expect.objectContaining({ cwd, services: ["auth"] }),
		);
		const out = stdoutText(stdout);
		expect(out).toContain("Neon setup needs a next step.");
		expect(out).toMatch(/Project\s+linked, not verified/);
		expect(out).toMatch(/neon login/);
		expect(out).toMatch(/neon deploy/);
		expect(out).not.toMatch(/neon link/);
		expect(out).not.toMatch(/claim create/);
	});

	test.each([
		{ name: "with an existing pin", existing: true },
		{ name: "in an empty directory", existing: false },
	])("a deferred link defers project-scoped MCP $name", async ({
		existing,
	}) => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-deferred-mcp-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const pin = { projectId: "prj-old", branch: "main" };
		if (existing) {
			writeFileSync(join(cwd, ".neon"), JSON.stringify(pin));
		}
		const ops = makeOperations();
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				projectId: "prj-new",
				mcpProjectScoped: true,
				mcpAuth: "oauth",
				agent: ["mcporter"],
				initConfig,
				hasLocalCredentials: () => false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(ops.installMcp).not.toHaveBeenCalled();
		expect(initConfig).toHaveBeenCalled();
		if (existing) {
			expect(
				JSON.parse(readFileSync(join(cwd, ".neon"), "utf8")),
			).toEqual(pin);
		}
		const out = stdoutText(stdout);
		expect(out).toMatch(/Agents\s+skipped/);
		expect(out).toContain("link --project-id prj-new");
		expect(out).toContain(
			"mcp -y --project-id prj-new --agent mcporter --oauth",
		);
	});

	test("an offline pin with only Postgres names env pull as the step after login", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-yes-offline-pg-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				yes: true,
				agentSetup: false,
				orgId: "org-example",
				projectId: "prj-example",
				branch: "main",
				hasLocalCredentials: () => false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		const out = stdoutText(stdout);
		expect(out).toContain("Then pull the branch's environment variables:");
		expect(out).toMatch(/neon env pull/);
	});

	test("an offline pin with an existing neon.ts does not name env pull as the next step", async () => {
		const cwd = mkdtempSync(
			join(tmpdir(), "neon-init-yes-offline-existing-"),
		);
		writeFileSync(join(cwd, "package.json"), "{}\n");
		writeFileSync(join(cwd, "neon.ts"), "export default {};\n");
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				yes: true,
				agentSetup: false,
				config: false,
				orgId: "org-example",
				projectId: "prj-example",
				branch: "main",
				hasLocalCredentials: () => false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		const out = stdoutText(stdout);
		expect(out).toMatch(/neon login/);
		expect(out).not.toContain(
			"Then pull the branch's environment variables:",
		);
	});

	test("-y with --project-id and no credentials keeps an existing pin and does not pull env", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-yes-relink-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		writeFileSync(
			join(cwd, ".neon-work"),
			JSON.stringify({ projectId: "prj-old", branch: "main" }),
		);
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const envPull = vi.fn().mockResolvedValue({ status: "empty" });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				yes: true,
				agentSetup: false,
				projectId: "prj-new",
				profile: "work",
				configDir: join(cwd, "creds"),
				contextFile: ".neon-work",
				linkProject,
				envPull,
				hasLocalCredentials: () => false,
			}),
		);

		expect(linkProject).not.toHaveBeenCalled();
		expect(envPull).not.toHaveBeenCalled();
		expect(
			JSON.parse(readFileSync(join(cwd, ".neon-work"), "utf8")),
		).toEqual({ projectId: "prj-old", branch: "main" });
		const out = stdoutText(stdout);
		expect(out).toContain(
			`login --profile work --config-dir ${join(cwd, "creds")}`,
		);
		expect(out).toContain(
			`link --project-id prj-new --context-file .neon-work --profile work --config-dir ${join(cwd, "creds")}`,
		);
	});

	test("Recommended configures MCP with OAuth when the credential cannot mint, then links", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mcp-fallback-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { CannotMintApiKeyError } = await import("../mcp/mint.js");
		const fallbackMcp = ops.installMcp.getMockImplementation();
		ops.installMcp.mockImplementation(async (options) => {
			if (options.oauth !== true) {
				throw new CannotMintApiKeyError();
			}
			return fallbackMcp?.(options) as never;
		});
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				projectId: "prj-example",
				linkProject,
				initConfig,
				detectProjectAgents: () => ["cursor", "opencode"],
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(ops.installMcp).toHaveBeenCalledTimes(2);
		expect(ops.installMcp.mock.calls[1]?.[0]).toMatchObject({
			oauth: true,
			agent: ["opencode"],
		});
		expect(stdoutText(warning)).toContain(
			"cannot mint an API key for the Neon MCP server",
		);
		expect(linkProject).toHaveBeenCalled();
		expect(initConfig).toHaveBeenCalled();
	});

	test("--mcp-auth api-key finishes the other steps, then reports the mint failure", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mcp-no-fallback-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { CannotMintApiKeyError } = await import("../mcp/mint.js");
		ops.installMcp.mockRejectedValue(new CannotMintApiKeyError());
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					operations: ops,
					yes: true,
					mcpAuth: "api-key",
					agent: ["opencode"],
					projectId: "prj-example",
					linkProject,
					initConfig,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(CannotMintApiKeyError);

		expect(ops.installMcp).toHaveBeenCalledTimes(1);
		expect(ops.installSkills).toHaveBeenCalledTimes(1);
		expect(linkProject).toHaveBeenCalled();
		expect(initConfig).toHaveBeenCalled();
		const out = stdoutText(stdout);
		expect(out).toContain("Neon setup failed.");
		expect(out).toContain("Agents   skills: opencode");
		expect(out).not.toContain("skills and MCP");
		expect(out).toContain(
			"mcp -y --agent opencode --api-key <personal-api-key>",
		);
		expect(out).toContain("mcp -y --agent opencode --oauth");
	});

	test("--mcp-auth api-key without credentials finishes the offline pin and neon.ts, then reports MCP", async () => {
		const cwd = mkdtempSync(
			join(tmpdir(), "neon-init-mcp-key-signed-out-"),
		);
		writeFileSync(join(cwd, "package.json"), "{}\n");
		writeFileSync(
			join(cwd, ".neon"),
			JSON.stringify({ projectId: "prj-old", branch: "main" }),
		);
		const ops = makeOperations();
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");
		const { MCP_API_KEY_NEEDS_AUTH } = await import("../init/copy.js");

		await expect(
			handler(
				baseProps({
					cwd,
					operations: ops,
					yes: true,
					mcpAuth: "api-key",
					agent: ["opencode"],
					orgId: "org-new",
					projectId: "prj-new",
					branch: "br-new",
					initConfig,
					hasLocalCredentials: () => false,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(MCP_API_KEY_NEEDS_AUTH);

		expect(ops.installMcp).not.toHaveBeenCalled();
		expect(initConfig).toHaveBeenCalled();
		expect(JSON.parse(readFileSync(join(cwd, ".neon"), "utf8"))).toEqual({
			orgId: "org-new",
			projectId: "prj-new",
			branch: "br-new",
		});
		const out = stdoutText(stdout);
		expect(out).toContain("Neon setup failed.");
		expect(out).toContain("minting its API key needs a signed-in CLI");
		expect(out).toContain(
			"mcp -y --agent opencode --api-key <personal-api-key>",
		);
		expect(out).toMatch(/neon login/);
	});

	test("without -y, API-key MCP runs after link signs in", async () => {
		const cwd = mkdtempSync(
			join(tmpdir(), "neon-init-mcp-key-interactive-"),
		);
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const linkProject = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				mcpAuth: "api-key",
				agent: ["opencode"],
				projectId: "prj-example",
				config: false,
				linkProject,
				hasLocalCredentials: () => false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(linkProject).toHaveBeenCalled();
		expect(ops.installMcp).toHaveBeenCalledTimes(1);
		expect(ops.installMcp.mock.calls[0]?.[0].oauth).toBeFalsy();
	});

	test("an MCP-only agent whose key cannot be minted reports no agent tooling", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mcp-only-fail-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { CannotMintApiKeyError } = await import("../mcp/mint.js");
		ops.installMcp.mockRejectedValue(new CannotMintApiKeyError());
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					operations: ops,
					yes: true,
					mcpAuth: "api-key",
					agent: ["mcporter"],
					link: false,
					config: false,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(CannotMintApiKeyError);

		expect(ops.installSkills).not.toHaveBeenCalled();
		const out = stdoutText(stdout);
		expect(out).toContain("Neon setup failed.");
		expect(out).toMatch(/Agents\s+skipped/);
		expect(out).not.toMatch(/Agents\s+.*MCP/);
	});

	test("Recommended installs the plugin globally for detected agents", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-rec-plugin-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				config: false,
				link: false,
				contextFile: join(cwd, ".neon"),
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(stepKinds(ops)).toEqual(["plugins"]);
		expect(ops.calls[0]?.options).toMatchObject({
			yes: true,
			global: true,
			agents: ["cursor"],
		});
		expect(takeCommandSuccessExtras()).toEqual({
			init_kind: "existing",
			agent_setup: "plugin",
		});
	});

	test("Recommended vscode-only uses the global plugin", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-vscode-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				config: false,
				link: false,
				contextFile: join(cwd, ".neon"),
				detectProjectAgents: () => ["vscode"],
			}),
		);

		expect(stepKinds(ops)).toEqual(["plugins"]);
		expect(ops.calls[0]?.options).toMatchObject({
			yes: true,
			global: true,
			agents: ["vscode"],
		});
	});

	test("Recommended mixed agents install plugin and skills/MCP", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mixed-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				config: false,
				link: false,
				contextFile: join(cwd, ".neon"),
				detectProjectAgents: () => ["cursor", "opencode"],
			}),
		);

		expect(stepKinds(ops)).toEqual(["plugins", "skills", "mcp"]);
		expect(ops.calls[0]?.options).toMatchObject({
			yes: true,
			global: true,
			agents: ["cursor"],
		});
		expect(takeCommandSuccessExtras()?.agent_setup).toBe("mixed");
	});

	test("named mixed agents succeed on init", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-named-mixed-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				agent: ["cursor", "opencode"],
				link: false,
				config: false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(stepKinds(ops)).toEqual(
			expect.arrayContaining(["plugins", "skills", "mcp"]),
		);
		expect(takeCommandSuccessExtras()?.agent_setup).toBe("mixed");
	});

	test("named --agent without -y is Custom and does not prompt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-named-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const pickMode = vi.fn(async () => "recommended" as const);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				agent: ["cursor", "claude-code"],
				link: false,
				config: false,
				pickMode,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(pickMode).not.toHaveBeenCalled();
		expect(stepKinds(ops)).toEqual(["plugins"]);
		expect(ops.calls[0]?.options).toMatchObject({
			// Named agents always run their step with -y (no picker needed),
			// even though init overall was interactive.
			yes: true,
			agents: ["cursor", "claude-code"],
		});
	});

	test("named global-only MCP agent uses the default global location", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-global-mcp-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				agent: ["windsurf"],
				link: false,
				config: false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(stepKinds(ops)).toEqual(["skills", "mcp"]);
		expect(ops.calls[0]?.options).toMatchObject({ agents: ["windsurf"] });
		expect(ops.calls[1]?.options).toMatchObject({ agent: ["windsurf"] });
	});

	test("oauth MCP scopes to the linked project when --mcp-project-scoped is set", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mcp-pin-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-pin", branch: "main" })}\n`,
		);
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				agent: ["opencode"],
				mcpAuth: "oauth",
				mcpConfigLocation: "project",
				mcpProjectScoped: true,
				link: false,
				config: false,
				contextFile,
			}),
		);

		const mcp = ops.calls.find((call) => call.kind === "mcp");
		expect(mcp?.options).toMatchObject({
			oauth: true,
			project: true,
			projectId: "proj-pin",
		});
		expect(stepKinds(ops)).toEqual(["skills", "mcp"]);
	});

	test("project MCP config rejects an unsupported agent", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mcp-location-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					operations: ops,
					yes: true,
					agent: ["windsurf"],
					skill: ["neon"],
					mcpAuth: "oauth",
					mcpConfigLocation: "project",
					link: false,
					config: false,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(
			/--agent windsurf cannot install project-level MCP config.*--mcp-config-location global/,
		);
		expect(ops.calls).toEqual([]);
	});

	test("project MCP config warns and continues when another agent is supported", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mcp-partial-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				agent: ["cursor", "windsurf"],
				skill: ["neon"],
				mcpAuth: "oauth",
				mcpConfigLocation: "project",
				link: false,
				config: false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(
			stderr.mock.calls.map((call) => String(call[0])).join(""),
		).toMatch(
			/Skipped project-level MCP config for windsurf.*--mcp-config-location global/,
		);
		const skills = ops.calls.find((call) => call.kind === "skills");
		expect(skills?.options.agents).toEqual(
			expect.arrayContaining(["cursor", "windsurf"]),
		);
		const mcp = ops.calls.find((call) => call.kind === "mcp");
		expect(mcp?.options.agent).toEqual(["cursor"]);
	});

	test("-y --skill is Custom skills, not Recommended plugin", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-yes-skill-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				skill: ["neon"],
				agent: ["cursor"],
				link: false,
				config: false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(stepKinds(ops)).toEqual(["skills"]);
		expect(ops.calls[0]?.options).toMatchObject({ skills: ["neon"] });
		expect(takeCommandSuccessExtras()?.agent_setup).toBe("skills");
	});

	test("-y --skill and --mcp-auth is skills and MCP", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-yes-skill-mcp-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				skill: ["neon"],
				mcpAuth: "oauth",
				agent: ["opencode"],
				link: false,
				config: false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(stepKinds(ops)).toEqual(["skills", "mcp"]);
		expect(ops.calls[0]?.options).toMatchObject({ skills: ["neon"] });
		const mcp = ops.calls.find((call) => call.kind === "mcp");
		expect(mcp?.options).toMatchObject({ oauth: true });
	});

	test("-y --mcp-auth with only an MCP-only agent detected skips fallback skills", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-yes-mcp-only-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		mkdirSync(join(cwd, "config"));
		writeFileSync(join(cwd, "config", "mcporter.json"), "{}\n");
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				mcpAuth: "oauth",
				link: false,
				config: false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(stepKinds(ops)).toEqual(["mcp"]);
		const mcp = ops.calls.find((call) => call.kind === "mcp");
		expect(mcp?.options.agent).toEqual(["mcporter"]);
	});

	test("-y --mcp-config-location project rejects a detected agent without project MCP", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-yes-mcp-location-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					operations: ops,
					yes: true,
					mcpConfigLocation: "project",
					mcpAuth: "oauth",
					detectInstalledAgents: async () => ["cline"],
					link: false,
					config: false,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow("cline cannot install project-level MCP config");
		expect(stepKinds(ops)).toEqual([]);
	});

	test("--no-agent-setup with --skill fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-skip-skill-"));
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					agentSetup: false,
					skill: ["neon"],
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(NO_AGENT_SETUP_CONFLICT);
	});

	test("-y --claimable is Custom and does not force Recommended", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-yes-claim-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const createClaimable = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				yes: true,
				claimable: true,
				agentSetup: false,
				config: false,
				hasLocalCredentials: () => false,
				createClaimable,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(createClaimable).toHaveBeenCalled();
	});

	test("-y --claimable with an MCP-only agent uses OAuth", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-claim-mcp-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const createClaimable = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				claimable: true,
				agent: ["mcporter"],
				config: false,
				hasLocalCredentials: () => false,
				createClaimable,
				contextFile: join(cwd, ".neon"),
			}),
		);

		const mcp = ops.calls.find((call) => call.kind === "mcp");
		expect(mcp?.options).toMatchObject({ oauth: true });
		expect(mcp?.options.agent).toEqual(["mcporter"]);
		expect(createClaimable).toHaveBeenCalled();
	});

	test("--claimable in an already linked directory fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-claim-linked-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "prj-existing", branch: "main" })}\n`,
		);
		const createClaimable = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					yes: true,
					claimable: true,
					agentSetup: false,
					config: false,
					createClaimable,
					contextFile,
				}),
			),
		).rejects.toThrow(CLAIMABLE_ALREADY_LINKED);
		expect(createClaimable).not.toHaveBeenCalled();
	});

	test("-y --claimable with credentials still defaults MCP to OAuth", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-claim-authed-mcp-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const createClaimable = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				yes: true,
				claimable: true,
				agent: ["mcporter"],
				mcpConfigLocation: "global",
				config: false,
				hasLocalCredentials: () => true,
				createClaimable,
				contextFile: join(cwd, ".neon"),
			}),
		);

		const mcp = ops.calls.find((call) => call.kind === "mcp");
		expect(mcp?.options).toMatchObject({ oauth: true });
		expect(mcp?.options.agent).toEqual(["mcporter"]);
		expect(createClaimable).toHaveBeenCalled();
	});

	test("-y --claimable --mcp-auth api-key fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-claim-apikey-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const createClaimable = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					yes: true,
					claimable: true,
					agent: ["mcporter"],
					mcpAuth: "api-key",
					config: false,
					hasLocalCredentials: () => true,
					createClaimable,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(CLAIMABLE_MCP_API_KEY);
		expect(createClaimable).not.toHaveBeenCalled();
	});

	test("--mcp-project-scoped without a linked project fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-pin-noproject-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					operations: makeOperations(),
					yes: true,
					mcpProjectScoped: true,
					agent: ["opencode"],
					link: false,
					config: false,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(MCP_SCOPED_NEEDS_PROJECT);
	});

	test("--skill with an agent that cannot install skills fails", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-skill-mcporter-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					yes: true,
					skill: ["neon"],
					agent: ["mcporter"],
					link: false,
					config: false,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(namedAgentsUnavailable(["mcporter"]));
	});

	test.each([
		[[], "skip"],
		[["skills"], "skills"],
		[["mcp"], "mcp"],
		[["skills", "mcp"], "skills-mcp"],
	] as const)("Custom runs selected steps %j and continues", async (steps, result) => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-skip-all-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				link: false,
				linkProject,
				initConfig,
				contextFile: join(cwd, ".neon"),
				pickAgentSetup: pickSkillsMcp,
				pickAgents: async ({
					setup,
				}: {
					setup: "plugin" | "skills" | "mcp";
				}) =>
					steps.some((step) => step === setup)
						? ["opencode"]
						: undefined,
				mcpConfigLocation: "global",
				mcpAuth: "oauth",
				pickConfig: async () => false,
			}),
		);

		expect(stepKinds(ops)).toEqual(steps);
		expect(linkProject).not.toHaveBeenCalled();
		expect(initConfig).not.toHaveBeenCalled();
		expect(takeCommandSuccessExtras()).toEqual({
			init_kind: "existing",
			agent_setup: result,
		});
	});

	test("Custom asks MCP location and auth only after MCP agents are picked", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mcp-order-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const asked: string[] = [];
		const { handler } = await import("./init.js");
		const run = (mcpAgents: AgentType[] | undefined) =>
			handler(
				baseProps({
					cwd,
					operations: makeOperations(),
					link: false,
					contextFile: join(cwd, ".neon"),
					pickAgentSetup: pickSkillsMcp,
					pickAgents: async ({
						setup,
					}: {
						setup: "plugin" | "skills" | "mcp";
					}) => {
						asked.push(`agents:${setup}`);
						return setup === "mcp" ? mcpAgents : ["opencode"];
					},
					pickSkills: async () => {
						asked.push("skills");
						return ["neon-postgres"];
					},
					pickMcpConfigLocation: async () => {
						asked.push("location");
						return "global";
					},
					pickMcpAuth: async () => {
						asked.push("auth");
						return "oauth";
					},
					pickConfig: async () => false,
				}),
			);

		await run(["opencode"]);
		expect(asked).toEqual([
			"agents:skills",
			"skills",
			"agents:mcp",
			"location",
			"auth",
		]);
		asked.length = 0;
		await run(undefined);
		expect(asked).toEqual(["agents:skills", "skills", "agents:mcp"]);
	});

	test("skipping MCP discards its API-key requirement for claimable setup", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-skip-mcp-"));
		const ops = makeOperations();
		const createClaimable = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");
		await handler(
			baseProps({
				cwd,
				contextFile: join(cwd, ".neon"),
				operations: ops,
				claimable: true,
				config: false,
				mcpAuth: "api-key",
				mcpConfigLocation: "global",
				pickAgents: async () => undefined,
				createClaimable,
			}),
		);
		expect(ops.calls).toEqual([]);
		expect(createClaimable).toHaveBeenCalledOnce();
	});

	test("Custom unauthenticated can create a claimable project", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-claim-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const createClaimable = vi.fn().mockResolvedValue(undefined);
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				contextFile: join(cwd, ".neon"),
				hasLocalCredentials: () => false,
				agentSetup: false,
				config: false,
				createClaimable,
				linkProject,
				pickProjectSetup: async () => "claimable",
			}),
		);

		expect(createClaimable).toHaveBeenCalled();
		expect(linkProject).not.toHaveBeenCalled();
	});

	test("Custom plugin then links in process without a consent prompt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-order-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const ops = makeOperations();
		const order: string[] = [];
		ops.installPlugins.mockImplementation(async (options) => {
			ops.calls.push({ kind: "plugins", options });
			order.push("plugins");
			return { scope: "global", rows: [], failed: [] };
		});
		const linkProject = vi.fn(async () => {
			order.push("link");
		});
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				contextFile: join(cwd, ".neon"),
				config: false,
				pickAgentSetup: async () => "plugin",
				detectProjectAgents: () => ["cursor"],
				linkProject,
			}),
		);

		expect(order).toEqual(["plugins", "link"]);
		expect(linkProject).toHaveBeenCalledWith(
			expect.objectContaining({
				config: false,
				cwd,
				envPull: true,
			}),
		);
	});

	test("--no-link skips authentication and linking", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-no-link-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		mkdirSync(join(cwd, ".cursor"));
		const ops = makeOperations();
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				link: false,
				linkProject,
				yes: true,
				config: false,
				contextFile: join(cwd, ".neon"),
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(stepKinds(ops)).toEqual(["plugins"]);
		expect(linkProject).not.toHaveBeenCalled();
	});

	test("link failure stops neon.ts setup", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-link-failure-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const linkProject = vi.fn().mockRejectedValue(new Error("link failed"));
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					operations: makeOperations(),
					linkProject,
					initConfig,
					contextFile: join(cwd, ".neon"),
					pickAgentSetup: async () => "skip",
				}),
			),
		).rejects.toThrow("link failed");

		expect(initConfig).not.toHaveBeenCalled();
	});

	test("already linked skips link and keeps an existing neon.ts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-linked-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		writeFileSync(join(cwd, "neon.ts"), "export default {};\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1" })}\n`,
		);
		const ops = makeOperations();
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: ops,
				contextFile,
				linkProject,
				initConfig,
				pickAgentSetup: pickSkillsMcp,
				detectProjectAgents: () => ["opencode"],
				pickSkills: async () => [],
				pickMcpConfigLocation: async () => "global",
				pickMcpAuth: async () => "oauth",
			}),
		);

		expect(linkProject).not.toHaveBeenCalled();
		expect(initConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd,
				install: true,
			}),
		);
		expect(stepKinds(ops)).toEqual(["skills", "mcp"]);
	});

	test("--no-config skips neon.ts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-no-config-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				yes: true,
				config: false,
				link: false,
				initConfig,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(initConfig).not.toHaveBeenCalled();
	});

	test("a failed env pull prints the failed heading and throws", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-env-fail-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1", branch: "main" })}\n`,
		);
		const envPull = vi
			.fn()
			.mockRejectedValue(new Error("env pull` failed"));
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					operations: makeOperations(),
					envPull,
					yes: true,
					contextFile,
					detectProjectAgents: () => ["cursor"],
				}),
			),
		).rejects.toThrow(/env pull` failed/);

		expect(envPull).toHaveBeenCalled();
		expect(stdoutText(stdout)).toContain("Neon setup failed.");
	});

	test("env pull after a new neon.ts on an already-linked branch", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-env-pull-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1", branch: "main" })}\n`,
		);
		const envPull = vi.fn().mockResolvedValue({ status: "empty" });
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				envPull,
				yes: true,
				link: false,
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(envPull).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd,
				projectId: "proj-1",
				branch: "main",
			}),
		);
	});

	test("extra services skip env pull after writing neon.ts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-extra-svc-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1", branch: "main" })}\n`,
		);
		const envPull = vi.fn().mockResolvedValue({ status: "empty" });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				envPull,
				yes: true,
				link: false,
				services: ["auth"],
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(envPull).not.toHaveBeenCalled();
		expect(stdoutText(stdout)).toContain("neon config plan");
	});

	test("env pull after neon.ts forwards an explicit API key", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-env-key-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1", branch: "main" })}\n`,
		);
		const { recordCredentialInputs: record } = await import(
			"@neon-internals/cli-core/auth_selection"
		);
		record({
			apiKeyFlag: "napi_flag",
			apiKeyEnv: "",
			profileEnv: "",
			profileFlag: "",
			configDir: "",
		});
		const envPull = vi.fn().mockResolvedValue({ status: "empty" });
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				envPull,
				yes: true,
				link: false,
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		// `ensureAuth` (inside the real `pullInitEnv`) reads the recorded credential inputs
		// itself; this test just confirms init still reaches the env-pull step at all with
		// the expected project/branch. The credential-precedence behavior itself is covered
		// by `commands/auth.test.ts`.
		expect(envPull).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "proj-1", branch: "main" }),
		);
	});

	test("does not pull env when neon.ts already existed", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-existing-ts-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		writeFileSync(join(cwd, "neon.ts"), "export default {};\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1", branch: "main" })}\n`,
		);
		const envPull = vi.fn().mockResolvedValue({ status: "empty" });
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				envPull,
				yes: true,
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(envPull).not.toHaveBeenCalled();
	});

	test("funnel start and end share an id", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-funnel-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const { handler } = await import("./init.js");
		const { trackEvent } = await import("../analytics.js");
		vi.mocked(trackEvent).mockClear();

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				yes: true,
				link: false,
				config: false,
				analytics: true,
				contextFile: join(cwd, ".neon"),
				detectProjectAgents: () => ["cursor"],
			}),
		);

		const start = vi
			.mocked(trackEvent)
			.mock.calls.find((call) => call[0] === "cli_init_start");
		const end = vi
			.mocked(trackEvent)
			.mock.calls.find((call) => call[0] === "cli_init_end");
		expect(start?.[1]).toEqual(
			expect.objectContaining({
				authenticated: true,
				empty_directory: false,
				interactive: false,
				detected_agents: ["cursor"],
			}),
		);
		expect(end?.[1]).toEqual(
			expect.objectContaining({
				mode: "recommended",
				agent_setup: "plugin",
				outcome: "success",
			}),
		);
		expect(
			(start?.[1] as { init_run_id: string } | undefined)?.init_run_id,
		).toBe((end?.[1] as { init_run_id: string } | undefined)?.init_run_id);
	});
});

describe("init CLI", () => {
	cliTest("help describes the orchestrator", async ({ testCliCommand }) => {
		const { stdout, stderr } = await testCliCommand(["init", "--help"], {
			snapshot: false,
		});
		const help = `${stdout}\n${stderr}`;
		const flat = help.replace(/\s+/g, " ");
		expect(help).toMatch(/Recommended setup/);
		expect(help).toMatch(/plugin/i);
		expect(help).toMatch(/--no-agent-setup/);
		expect(help).toMatch(/-a, --agent/);
		expect(help).toMatch(/--claimable/);
		expect(help).toMatch(/--mcp-project-scoped/);
		expect(help).toMatch(/--mcp-config-location/);
		expect(help).not.toMatch(/--mcp-scope/);
		expect(help).not.toMatch(/--mcp-project-pin/);
		expect(help).not.toMatch(/--no-mcp-project-pin/);
		expect(help).not.toMatch(/--skip-template/);
		expect(help).not.toMatch(/--template/);
		expect(help).not.toMatch(/--project-setup/);
		expect(help).toMatch(/--no-link/);
		expect(help).toMatch(/--no-config/);
		expect(flat).toMatch(/does not scaffold/i);
		expect(flat).toMatch(/forwarded to plugins, or to skills and mcp/i);
		expect(help).toMatch(/Plugin agents/);
		expect(help).toMatch(/Skills and MCP agents/);
		expect(help).not.toMatch(/installed apps/);
		expect(help).not.toMatch(/Set output format/);
	});

	test("Ctrl-C at the mode picker prints the cancellation summary", async () => {
		const root = mkdtempSync(join(tmpdir(), "neon-init-cancel-"));
		const spawnHelper = join(
			process.cwd(),
			"node_modules",
			"node-pty",
			"prebuilds",
			`${process.platform}-${process.arch}`,
			"spawn-helper",
		);
		if (existsSync(spawnHelper)) {
			chmodSync(spawnHelper, 0o755);
		}
		let output = "";
		const term = spawnPty(
			process.execPath,
			[
				join(process.cwd(), "dist/index.js"),
				"init",
				"--no-analytics",
				"--config-dir",
				join(root, "config"),
				"--context-file",
				join(root, ".neon"),
			],
			{
				name: "xterm-256color",
				cols: 120,
				rows: 40,
				cwd: root,
				env: {
					...process.env,
					CI: "",
					HOME: root,
					USERPROFILE: root,
					XDG_CONFIG_HOME: join(root, ".config"),
				},
			},
		);
		term.onData((chunk) => {
			output += chunk;
		});

		await waitForPtyText(
			term,
			() => output,
			"How would you like to set up Neon?",
		);
		term.write("\x03");

		expect(await waitForPtyExit(term)).toBe(1);
		const rendered = stripAnsi(output);
		expect(rendered).toContain("Neon setup cancelled.");
		expect(rendered).not.toContain("InitCancelled:");
	}, 20_000);

	test("Custom plugin picker does not preselect an agent whose plugin command is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "neon-init-preselect-"));
		mkdirSync(join(root, ".copilot"));
		mkdirSync(join(root, ".cursor"));
		const nodeBin = join(root, "node-bin");
		mkdirSync(nodeBin);
		symlinkSync(process.execPath, join(nodeBin, "node"));
		const spawnHelper = join(
			process.cwd(),
			"node_modules",
			"node-pty",
			"prebuilds",
			`${process.platform}-${process.arch}`,
			"spawn-helper",
		);
		if (existsSync(spawnHelper)) {
			chmodSync(spawnHelper, 0o755);
		}
		let output = "";
		const term = spawnPty(
			process.execPath,
			[
				join(process.cwd(), "dist/index.js"),
				"init",
				"--no-link",
				"--no-config",
				"--no-analytics",
				"--config-dir",
				join(root, "config"),
				"--context-file",
				join(root, ".neon"),
			],
			{
				name: "xterm-256color",
				cols: 120,
				rows: 40,
				cwd: root,
				// No XDG_CONFIG_HOME: add-mcp would look for Copilot CLI under it instead of ~/.copilot.
				env: {
					...Object.fromEntries(
						Object.entries(process.env).filter(
							([key]) => key !== "XDG_CONFIG_HOME",
						),
					),
					CI: "",
					HOME: root,
					USERPROFILE: root,
					PATH: nodeBin,
				},
			},
		);
		term.onData((chunk) => {
			output += chunk;
		});

		const exited = waitForPtyExit(term);
		try {
			await waitForPtyText(
				term,
				() => output,
				"How should Neon be added to your coding agents?",
			);
			term.write("\r");
			await waitForPtyText(term, () => output, "VS Code (vscode)");
			const rendered = stripAnsi(output);
			expect(rendered).toMatch(/◉\s+Cursor \(cursor\)/);
			expect(rendered).toMatch(
				/◯\s+GitHub Copilot CLI \(github-copilot-cli\)/,
			);
			term.write("\x1b[B".repeat(4));
			await waitForPtyText(
				term,
				() => output,
				'Detected, but "copilot" was not found on PATH. Its plugin cannot install.',
			);
		} finally {
			term.kill();
			await exited;
			rmSync(root, { recursive: true, force: true });
		}
	}, 20_000);

	cliTest("rejects --data", async ({ testCliCommand }) => {
		await testCliCommand(["init", "--data", '{"step":"auth"}'], {
			snapshot: false,
			code: 1,
			stderr: expect.stringContaining("was removed"),
		});
	});

	cliTest("rejects --output json", async ({ testCliCommand }) => {
		await testCliCommand(["init"], {
			snapshot: false,
			output: "json",
			code: 1,
			stderr: expect.stringContaining("does not support --output"),
		});
	});

	cliTest("rejects --agent without a value", async ({ testCliCommand }) => {
		const { stderr } = await testCliCommand(["init", "--agent"], {
			snapshot: false,
			code: 1,
		});
		expect(stderr).toMatch(/--agent needs a value/);
	});

	cliTest("rejects an unknown --agent", async ({ testCliCommand }) => {
		const { stderr } = await testCliCommand(
			["init", "-y", "--agent", "not-an-agent"],
			{ snapshot: false, code: 1, outputTable: true },
		);
		expect(stderr).toMatch(/Unknown agent: "not-an-agent"/);
		expect(stderr).not.toMatch(/Unknown argument: agent/);
	});

	cliTest(
		"rejects --no-config with --services",
		async ({ testCliCommand }) => {
			const { stderr } = await testCliCommand(
				["init", "--no-config", "--services", "auth"],
				{ snapshot: false, code: 1, outputTable: true },
			);
			expect(stderr).toMatch(
				/--no-config cannot be combined with --services/,
			);
		},
	);

	cliTest(
		"rejects --no-config with --realtime",
		async ({ testCliCommand }) => {
			const { stderr } = await testCliCommand(
				["init", "--no-config", "--realtime"],
				{ snapshot: false, code: 1, outputTable: true },
			);
			expect(stderr).toMatch(
				/--no-config cannot be combined with --realtime/,
			);
		},
	);

	cliTest("rejects removed template flags", async ({ testCliCommand }) => {
		for (const flag of ["--template", "--skip-template"]) {
			const { stderr } = await testCliCommand(
				flag === "--template" ? ["init", flag, "hono"] : ["init", flag],
				{ snapshot: false, code: 1 },
			);
			expect(stderr).toMatch(/Unknown argument/);
		}
	});

	cliTest(
		"empty -y --no-config --no-link sets up in place",
		async ({ testCliCommand }) => {
			const root = mkdtempSync(join(tmpdir(), "neon-init-cli-empty-"));
			const cwd = join(root, "app");
			mkdirSync(cwd);
			const { stdout, stderr } = await testCliCommand(
				["init", "-y", "--no-config", "--no-link"],
				{
					snapshot: false,
					outputTable: true,
					apiKey: false,
					cwd,
					env: {
						HOME: root,
						USERPROFILE: root,
						XDG_CONFIG_HOME: join(root, ".config"),
						APPDATA: join(root, "AppData"),
						CODEX_HOME: join(root, ".codex"),
						CI: "true",
						...npmEnvForIsolatedHome(),
					},
				},
			);
			expect(`${stdout}\n${stderr}`).toMatch(
				/No coding agents detected/i,
			);
			expect(existsSync(join(cwd, ".agents"))).toBe(true);
			expect(existsSync(join(cwd, "package.json"))).toBe(false);
		},
		30_000,
	);

	cliTest(
		"unattended -y --no-config without auth prints the link next step",
		async ({ testCliCommand }) => {
			const root = mkdtempSync(join(tmpdir(), "neon-init-cli-unauth-"));
			const cwd = join(root, "app");
			mkdirSync(cwd);
			writeFileSync(join(cwd, "README.md"), "app\n");
			const { stdout, stderr } = await testCliCommand(
				["init", "-y", "--no-config"],
				{
					snapshot: false,
					outputTable: true,
					apiKey: false,
					cwd,
					env: {
						HOME: root,
						USERPROFILE: root,
						XDG_CONFIG_HOME: join(root, ".config"),
						APPDATA: join(root, "AppData"),
						CODEX_HOME: join(root, ".codex"),
						CI: "true",
						...npmEnvForIsolatedHome(),
					},
				},
			);
			const out = `${stdout}\n${stderr}`;
			expect(out).toContain("https://neon.com/signup");
			expect(out).toMatch(/neon link/);
			expect(out).toMatch(/neon claim create/);
		},
		30_000,
	);

	test("Custom skip records empty-skip and skip", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-telem-skip-"));
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				contextFile: join(cwd, ".neon"),
				pickAgentSetup: async () => "skip",
				pickConfig: async () => false,
				link: false,
			}),
		);

		expect(takeCommandSuccessExtras()).toEqual({
			init_kind: "empty-skip",
			agent_setup: "skip",
		});
	});

	test("existing directory records existing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-telem-existing-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				operations: makeOperations(),
				contextFile: join(cwd, ".neon"),
				link: false,
				config: false,
				pickAgentSetup: pickSkillsMcp,
				detectProjectAgents: () => ["opencode"],
				pickSkills: async () => [],
				pickMcpConfigLocation: async () => "global",
				pickMcpAuth: async () => "oauth",
			}),
		);

		expect(takeCommandSuccessExtras()).toEqual({
			init_kind: "existing",
			agent_setup: "skills-mcp",
		});
	});
});

describe("init flag parsing", () => {
	const parse = async (args: string[]) =>
		(await builder(
			yargs().scriptName("neon").exitProcess(false),
		).parseAsync(args)) as {
			config?: boolean;
			link?: boolean;
			agentSetup?: boolean;
			realtime?: boolean;
		};

	test("--config is a three-state flag", async () => {
		expect((await parse([])).config).toBeUndefined();
		expect((await parse(["--config"])).config).toBe(true);
		expect((await parse(["--no-config"])).config).toBe(false);
	});

	test("--realtime is a three-state flag", async () => {
		expect((await parse([])).realtime).toBeUndefined();
		expect((await parse(["--realtime"])).realtime).toBe(true);
		expect((await parse(["--no-realtime"])).realtime).toBe(false);
	});

	test("--no-link skips project linking", async () => {
		expect((await parse([])).link).toBe(true);
		expect((await parse(["--no-link"])).link).toBe(false);
	});

	test("--no-agent-setup skips agent setup", async () => {
		expect((await parse(["--no-agent-setup"])).agentSetup).toBe(false);
		expect((await parse([])).agentSetup).toBe(true);
	});

	test("--claimable is a boolean flag", async () => {
		const argv = (await builder(
			yargs().scriptName("neon").exitProcess(false),
		).parseAsync(["--claimable"])) as { claimable?: boolean };
		expect(argv.claimable).toBe(true);
		expect(
			(
				(await builder(
					yargs().scriptName("neon").exitProcess(false),
				).parseAsync([])) as { claimable?: boolean }
			).claimable,
		).toBe(false);
	});

	test("--mcp-config-location is parsed", async () => {
		const argv = (await builder(
			yargs().scriptName("neon").exitProcess(false),
		).parseAsync(["--mcp-config-location", "project"])) as {
			mcpConfigLocation?: string;
		};
		expect(argv.mcpConfigLocation).toBe("project");
		expect(
			(
				(await builder(
					yargs().scriptName("neon").exitProcess(false),
				).parseAsync([])) as { mcpConfigLocation?: string }
			).mcpConfigLocation,
		).toBeUndefined();
	});

	test("--mcp-project-scoped is true only when passed", async () => {
		const argv = (await builder(
			yargs().scriptName("neon").exitProcess(false),
		).parseAsync(["--mcp-project-scoped"])) as {
			mcpProjectScoped?: boolean;
		};
		expect(argv.mcpProjectScoped).toBe(true);
		expect(
			(
				(await builder(
					yargs().scriptName("neon").exitProcess(false),
				).parseAsync([])) as { mcpProjectScoped?: boolean }
			).mcpProjectScoped,
		).toBe(false);
	});

	test("--services postgres is the raw postgres token", async () => {
		const argv = (await builder(
			yargs().scriptName("neon").exitProcess(false),
		).parseAsync(["--services", "postgres"])) as { services?: unknown };
		expect(argv.services).toEqual(["postgres"]);
	});
});
