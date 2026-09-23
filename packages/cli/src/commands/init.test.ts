import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCredentialInputs } from "@neon-internals/cli-core/auth_selection";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import yargs from "yargs";
import { takeCommandSuccessExtras } from "../analytics.js";
import {
	CLAIMABLE_ALREADY_LINKED,
	CLAIMABLE_MCP_API_KEY,
	MCP_SCOPED_NEEDS_PROJECT,
	NO_AGENT_SETUP_CONFLICT,
	namedAgentsUnavailable,
	YES_LINK_NEEDS_AUTH,
} from "../init/copy.js";
import type { InitAgentSetup } from "../init/plan.js";
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

const baseProps = (overrides: Record<string, unknown> = {}) => ({
	apiClient: {} as never,
	apiKey: "test-key",
	apiHost: host,
	output: "table" as const,
	contextFile: "/tmp/does-not-exist/.neon",
	linkProject: vi.fn().mockResolvedValue(undefined),
	initConfig: vi.fn().mockResolvedValue(undefined),
	hasLocalCredentials: () => true,
	detectInstalledAgents: async () => [],
	detectAgent: () => null,
	analytics: false,
	...overrides,
});

const argvLine = (run: ReturnType<typeof vi.fn>): string[] =>
	run.mock.calls.map((call) => (call[0] as string[]).join(" "));

const argvHeads = (run: ReturnType<typeof vi.fn>): string[] =>
	run.mock.calls.map((call) => (call[0] as string[])[0] ?? "");

const stdoutText = (spy: { mock: { calls: unknown[][] } }): string =>
	spy.mock.calls.map((call) => String(call[0])).join("");

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
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(baseProps({ cwd, run, contextFile: join(cwd, ".neon") })),
		).rejects.toThrow(/Pass -y to use defaults/);
		expect(run).not.toHaveBeenCalled();
	});

	test("existing app without -y fails before children", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-ci-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(baseProps({ cwd, run, contextFile: join(cwd, ".neon") })),
		).rejects.toThrow(/Pass -y to use defaults/);
		expect(run).not.toHaveBeenCalled();
	});

	test("empty -y is Recommended in place: skills fallback, link, default neon.ts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-y-"));
		const run = vi.fn().mockResolvedValue(true);
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
				initConfig,
				linkProject,
			}),
		);

		expect(argvLine(run).some((line) => line.startsWith("bootstrap"))).toBe(
			false,
		);
		expect(argvLine(run)[0]).toContain("skills -y");
		expect(argvLine(run)[0]).not.toContain("--global");
		expect(argvLine(run)[0]).toContain("--agent cursor");
		expect(argvLine(run)[0]).toContain("--agent codex");
		expect(argvHeads(run)).not.toContain("mcp");
		expect(linkProject).toHaveBeenCalled();
		expect(initConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd,
				install: true,
				services: ["none"],
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

	test("empty -y without auth skips link and prints the next step", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-unauth-"));
		const run = vi.fn().mockResolvedValue(true);
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
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
		expect(out).toMatch(/neon auth/);
		expect(out).toMatch(/neon link/);
		expect(out).toMatch(/neon claim create/);
	});

	test("Custom -y unanswered project setup skips link when unauthenticated", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-custom-unauth-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
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

	test("-y with --project-id refuses to open sign-in", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-yes-project-id-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					yes: true,
					projectId: "prj-example",
					agentSetup: false,
					config: false,
					linkProject,
					hasLocalCredentials: () => false,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(YES_LINK_NEEDS_AUTH);
		expect(linkProject).not.toHaveBeenCalled();
	});

	test("Recommended installs the plugin globally for detected agents", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-rec-plugin-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				config: false,
				link: false,
				contextFile: join(cwd, ".neon"),
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(argvLine(run)[0]).toContain(
			"plugins --global -y --agent cursor",
		);
		expect(takeCommandSuccessExtras()).toEqual({
			init_kind: "existing",
			agent_setup: "plugin",
		});
	});

	test("Recommended vscode-only uses the global plugin", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-vscode-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				config: false,
				link: false,
				contextFile: join(cwd, ".neon"),
				detectProjectAgents: () => ["vscode"],
			}),
		);

		expect(argvLine(run)[0]).toContain(
			"plugins --global -y --agent vscode",
		);
	});

	test("Recommended mixed agents install plugin and skills/MCP", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mixed-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				config: false,
				link: false,
				contextFile: join(cwd, ".neon"),
				detectProjectAgents: () => ["cursor", "opencode"],
			}),
		);

		expect(argvHeads(run)).toEqual(["plugins", "skills", "mcp"]);
		expect(argvLine(run)[0]).toContain(
			"plugins --global -y --agent cursor",
		);
		expect(takeCommandSuccessExtras()?.agent_setup).toBe("mixed");
	});

	test("named mixed agents succeed on init", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-named-mixed-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				agent: ["cursor", "opencode"],
				link: false,
				config: false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(argvHeads(run)).toEqual(
			expect.arrayContaining(["plugins", "skills", "mcp"]),
		);
		expect(takeCommandSuccessExtras()?.agent_setup).toBe("mixed");
	});

	test("named --agent without -y is Custom and does not prompt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-named-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const pickMode = vi.fn(async () => "recommended" as const);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				agent: ["cursor", "claude-code"],
				link: false,
				config: false,
				pickMode,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(pickMode).not.toHaveBeenCalled();
		expect(argvLine(run)[0]).toContain(
			"plugins -y --agent cursor --agent claude-code",
		);
	});

	test("oauth MCP scopes to the linked project when --mcp-project-scoped is set", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mcp-pin-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-pin", branch: "main" })}\n`,
		);
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				agent: ["opencode"],
				mcpAuth: "oauth",
				mcpConfigLocation: "project",
				mcpProjectScoped: true,
				link: false,
				config: false,
				contextFile,
			}),
		);

		const mcp = argvLine(run).find((line) => line.startsWith("mcp "));
		expect(mcp).toContain("--oauth");
		expect(mcp?.split(" ")).toContain("--project");
		expect(mcp).toContain("--project-id proj-pin");
	});

	test("project MCP config rejects an unsupported agent", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mcp-location-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
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
		expect(run).not.toHaveBeenCalled();
	});

	test("project MCP config warns and continues when another agent is supported", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mcp-partial-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
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
		const skills = argvLine(run).find((line) => line.startsWith("skills "));
		expect(skills).toContain("--agent cursor");
		expect(skills).toContain("--agent windsurf");
		const mcp = argvLine(run).find((line) => line.startsWith("mcp "));
		expect(mcp).toContain("--agent cursor");
		expect(mcp).not.toContain("--agent windsurf");
	});

	test("-y --skill is Custom skills, not Recommended plugin", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-yes-skill-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				skill: ["neon"],
				agent: ["cursor"],
				link: false,
				config: false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(argvHeads(run)).toEqual(["skills"]);
		expect(argvLine(run)[0]).toContain("--skill neon");
		expect(argvLine(run)[0]).not.toContain("plugins");
		expect(takeCommandSuccessExtras()?.agent_setup).toBe("skills");
	});

	test("-y --skill and --mcp-auth is skills and MCP", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-yes-skill-mcp-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				skill: ["neon"],
				mcpAuth: "oauth",
				agent: ["opencode"],
				link: false,
				config: false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(argvHeads(run)).toEqual(["skills", "mcp"]);
		expect(argvLine(run)[0]).toContain("--skill neon");
		expect(argvLine(run).find((line) => line.startsWith("mcp "))).toContain(
			"--oauth",
		);
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
		const run = vi.fn().mockResolvedValue(true);
		const createClaimable = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				claimable: true,
				agent: ["mcporter"],
				config: false,
				hasLocalCredentials: () => false,
				createClaimable,
				contextFile: join(cwd, ".neon"),
			}),
		);

		const mcp = argvLine(run).find((line) => line.startsWith("mcp "));
		expect(mcp).toContain("--oauth");
		expect(mcp).toContain("--agent mcporter");
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
		const run = vi.fn().mockResolvedValue(true);
		const createClaimable = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
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

		const mcp = argvLine(run).find((line) => line.startsWith("mcp "));
		expect(mcp).toContain("--oauth");
		expect(mcp).toContain("--agent mcporter");
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
					run: vi.fn().mockResolvedValue(true),
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

	test("Custom skip plus --no-link plus declining neon.ts writes nothing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-skip-all-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				link: false,
				linkProject,
				initConfig,
				contextFile: join(cwd, ".neon"),
				pickAgentSetup: async () => "skip",
				pickConfig: async () => false,
			}),
		);

		expect(run).not.toHaveBeenCalled();
		expect(linkProject).not.toHaveBeenCalled();
		expect(initConfig).not.toHaveBeenCalled();
		expect(takeCommandSuccessExtras()).toEqual({
			init_kind: "existing",
			agent_setup: "skip",
		});
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
				run: vi.fn().mockResolvedValue(true),
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
		const calls: string[] = [];
		const run = vi.fn(async (argv: string[]) => {
			calls.push(argv[0] ?? "");
			return true;
		});
		const linkProject = vi.fn(async () => {
			calls.push("link");
		});
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: join(cwd, ".neon"),
				config: false,
				pickAgentSetup: async () => "plugin",
				detectProjectAgents: () => ["cursor"],
				linkProject,
			}),
		);

		expect(calls).toEqual(["plugins", "link"]);
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
		const run = vi.fn().mockResolvedValue(true);
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				link: false,
				linkProject,
				yes: true,
				config: false,
				contextFile: join(cwd, ".neon"),
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(argvHeads(run)).toEqual(["plugins"]);
		expect(linkProject).not.toHaveBeenCalled();
	});

	test("link failure stops neon.ts setup", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-link-failure-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const linkProject = vi.fn().mockRejectedValue(new Error("link failed"));
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
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
		const run = vi.fn().mockResolvedValue(true);
		const linkProject = vi.fn().mockResolvedValue(undefined);
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
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
		expect(argvHeads(run)).toEqual(["skills", "mcp"]);
	});

	test("--no-config skips neon.ts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-no-config-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const initConfig = vi.fn().mockResolvedValue(undefined);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run: vi.fn().mockResolvedValue(true),
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
		const run = vi.fn(async (argv: string[]) => argv[0] !== "env");
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
					yes: true,
					contextFile,
					detectProjectAgents: () => ["cursor"],
				}),
			),
		).rejects.toThrow(/env pull` failed/);

		expect(argvHeads(run)).toContain("env");
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
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				link: false,
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(
			run.mock.calls
				.find((call) => call[0][0] === "env")?.[0]
				.slice(0, 2),
		).toEqual(["env", "pull"]);
	});

	test("extra services skip env pull after writing neon.ts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-extra-svc-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1", branch: "main" })}\n`,
		);
		const run = vi.fn().mockResolvedValue(true);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				link: false,
				services: ["auth"],
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(argvHeads(run)).not.toContain("env");
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
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				link: false,
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(
			run.mock.calls.find((call) => call[0][0] === "env")?.[2],
		).toEqual({ NEON_API_KEY: "napi_flag" });
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
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(argvHeads(run)).not.toContain("env");
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
				run: vi.fn().mockResolvedValue(true),
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
				run: vi.fn().mockResolvedValue(true),
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
				run: vi.fn().mockResolvedValue(true),
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
		};

	test("--config is a three-state flag", async () => {
		expect((await parse([])).config).toBeUndefined();
		expect((await parse(["--config"])).config).toBe(true);
		expect((await parse(["--no-config"])).config).toBe(false);
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

	test("--services none is the raw none token", async () => {
		const argv = (await builder(
			yargs().scriptName("neon").exitProcess(false),
		).parseAsync(["--services", "none"])) as { services?: unknown };
		expect(argv.services).toEqual(["none"]);
	});
});
