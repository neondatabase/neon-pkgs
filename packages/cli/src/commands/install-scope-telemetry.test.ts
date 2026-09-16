import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { takeCommandSuccessExtras } from "../analytics.js";

const runPluginsCli = vi.hoisted(() => vi.fn());
const confirmPluginsInstall = vi.hoisted(() => vi.fn());
const runSkillsCli = vi.hoisted(() => vi.fn());
const confirmSkillsInstall = vi.hoisted(() => vi.fn());
const pickMcpScope = vi.hoisted(() => vi.fn());
const confirmMcpInstall = vi.hoisted(() => vi.fn());
const canPickAgentsInteractively = vi.hoisted(() => vi.fn());
const installNeonMcpServer = vi.hoisted(() => vi.fn());

vi.mock("../plugins/run.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../plugins/run.js")>();
	return { ...actual, runPluginsCli };
});

vi.mock("../plugins/wizard.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../plugins/wizard.js")>();
	return { ...actual, confirmPluginsInstall };
});

vi.mock("../skills/run.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../skills/run.js")>();
	return { ...actual, runSkillsCli };
});

vi.mock("../skills/wizard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../skills/wizard.js")>();
	return { ...actual, confirmSkillsInstall };
});

vi.mock("../mcp/wizard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../mcp/wizard.js")>();
	return { ...actual, pickMcpScope, confirmMcpInstall };
});

vi.mock("../mcp/install.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../mcp/install.js")>();
	return { ...actual, installNeonMcpServer };
});

vi.mock("../utils/agent_picker.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../utils/agent_picker.js")>();
	return { ...actual, canPickAgentsInteractively };
});

const dirs: string[] = [];
const previousCwd = process.cwd();

const scratch = (): string => {
	const cwd = mkdtempSync(join(tmpdir(), "neon-scope-telem-"));
	dirs.push(cwd);
	return cwd;
};

const baseProps = () => ({
	apiClient: {} as never,
	apiKey: "test-key",
	apiHost: "https://console.neon.tech/api/v2",
	output: "table" as const,
	contextFile: join(scratch(), ".neon"),
});

beforeEach(() => {
	runPluginsCli.mockReset().mockResolvedValue(undefined);
	confirmPluginsInstall.mockReset().mockResolvedValue(true);
	runSkillsCli.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
	confirmSkillsInstall.mockReset().mockResolvedValue(true);
	pickMcpScope.mockReset().mockResolvedValue("project");
	confirmMcpInstall.mockReset().mockResolvedValue(true);
	canPickAgentsInteractively.mockReset().mockReturnValue(false);
	installNeonMcpServer.mockReset().mockReturnValue({
		ok: true,
		path: "/tmp/mcp.json",
	});
	takeCommandSuccessExtras();
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(() => {
	process.chdir(previousCwd);
	takeCommandSuccessExtras();
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("install scope telemetry", () => {
	test("plugins -y records project scope", async () => {
		const cwd = scratch();
		process.chdir(cwd);
		const { handler } = await import("./plugins.js");
		await handler({
			...baseProps(),
			yes: true,
			agent: ["cursor"],
		});
		expect(takeCommandSuccessExtras()).toEqual({ scope: "project" });
	});

	test("plugins --global records global scope", async () => {
		const cwd = scratch();
		process.chdir(cwd);
		const { handler } = await import("./plugins.js");
		await handler({
			...baseProps(),
			yes: true,
			global: true,
			agent: ["cursor"],
		});
		expect(takeCommandSuccessExtras()).toEqual({ scope: "global" });
	});

	test("plugins confirmation refusal records nothing", async () => {
		canPickAgentsInteractively.mockReturnValue(true);
		confirmPluginsInstall.mockResolvedValue(false);
		const cwd = scratch();
		process.chdir(cwd);
		const { handler } = await import("./plugins.js");
		await handler({
			...baseProps(),
			agent: ["cursor"],
		});
		expect(runPluginsCli).not.toHaveBeenCalled();
		expect(takeCommandSuccessExtras()).toEqual({});
	});

	test("skills -y records project scope", async () => {
		const cwd = scratch();
		process.chdir(cwd);
		const { handler } = await import("./skills.js");
		await handler({
			...baseProps(),
			yes: true,
			agent: ["cursor"],
			skill: ["neon"],
		});
		expect(takeCommandSuccessExtras()).toEqual({ scope: "project" });
	});

	test("skills --global records global scope", async () => {
		const cwd = scratch();
		process.chdir(cwd);
		const { handler } = await import("./skills.js");
		await handler({
			...baseProps(),
			yes: true,
			global: true,
			agent: ["cursor"],
			skill: ["neon"],
		});
		expect(takeCommandSuccessExtras()).toEqual({ scope: "global" });
	});

	test("mcp -y records global scope", async () => {
		const cwd = scratch();
		process.chdir(cwd);
		const { handler } = await import("./mcp.js");
		await handler({
			...baseProps(),
			yes: true,
			oauth: true,
			agent: ["cursor"],
		});
		expect(takeCommandSuccessExtras()).toEqual({ scope: "global" });
	});

	test("mcp --project records project scope", async () => {
		const cwd = scratch();
		process.chdir(cwd);
		const { handler } = await import("./mcp.js");
		await handler({
			...baseProps(),
			yes: true,
			oauth: true,
			project: true,
			agent: ["cursor"],
		});
		expect(takeCommandSuccessExtras()).toEqual({ scope: "project" });
	});

	test("interactive mcp scope follows the picker, not the flag default", async () => {
		canPickAgentsInteractively.mockReturnValue(true);
		pickMcpScope.mockResolvedValue("project");
		const cwd = scratch();
		process.chdir(cwd);
		const { handler } = await import("./mcp.js");
		await handler({
			...baseProps(),
			oauth: true,
			agent: ["cursor"],
		});
		expect(pickMcpScope).toHaveBeenCalled();
		expect(takeCommandSuccessExtras()).toEqual({ scope: "project" });
	});

	test("mcp confirmation refusal records nothing", async () => {
		canPickAgentsInteractively.mockReturnValue(true);
		pickMcpScope.mockResolvedValue("global");
		confirmMcpInstall.mockResolvedValue(false);
		const cwd = scratch();
		process.chdir(cwd);
		const { handler } = await import("./mcp.js");
		await handler({
			...baseProps(),
			oauth: true,
			agent: ["cursor"],
		});
		expect(takeCommandSuccessExtras()).toEqual({});
	});
});
