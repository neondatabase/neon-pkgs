import strip from "strip-ansi";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	agentSetupDoneLabel,
	agentsRowValue,
	configSummaryLabel,
	formatInitBanner,
	formatInitDone,
	INIT_BANNER_LINES,
	printInitBanner,
	printInitDone,
	shouldPrintInitBanner,
} from "./chrome.js";

describe("agentsRowValue", () => {
	test("names skills and MCP agents separately when they differ", () => {
		expect(
			agentsRowValue({
				tooling: {
					setup: "skills-mcp",
					skillsAgents: ["cursor"],
					mcpAgents: ["claude-code"],
				},
				installed: ["cursor", "claude-code"],
			}),
		).toBe("skills: cursor; MCP: claude-code");
	});

	test("keeps one list when skills and MCP go to the same agents", () => {
		expect(
			agentsRowValue({
				tooling: {
					setup: "skills-mcp",
					skillsAgents: ["cursor"],
					mcpAgents: ["cursor"],
				},
				installed: ["cursor"],
			}),
		).toBe("skills and MCP: cursor");
	});

	test("names the plugin agents and the skills/MCP agents of a mixed run", () => {
		expect(
			agentsRowValue({
				tooling: {
					setup: "mixed",
					pluginAgents: ["claude-code", "codex"],
					skillsAgents: ["github-copilot-cli"],
					mcpAgents: ["github-copilot-cli"],
				},
				installed: ["claude-code", "codex", "github-copilot-cli"],
			}),
		).toBe(
			"Neon plugin: claude-code, codex; skills and MCP: github-copilot-cli",
		);
	});

	test("skills-only names the agents", () => {
		expect(
			agentsRowValue({
				tooling: { setup: "skills", agents: ["cursor"] },
				installed: ["cursor"],
			}),
		).toBe("skills: cursor");
	});

	test("lists only agents that installed, else the setup label", () => {
		const tooling = {
			setup: "skills-mcp",
			skillsAgents: ["cursor"],
			mcpAgents: ["claude-code"],
		} as const;
		expect(agentsRowValue({ tooling, installed: ["cursor"] })).toBe(
			"skills: cursor",
		);
		expect(agentsRowValue({ tooling, installed: [] })).toBe(
			"skills and MCP",
		);
		expect(
			agentsRowValue({ tooling: { setup: "skip" }, installed: [] }),
		).toBe("skipped");
	});
});

describe("formatInitBanner", () => {
	test("is the six-line NEON mark", () => {
		expect(INIT_BANNER_LINES).toEqual([
			" ██╗  ██╗██████╗ ██████╗ ██╗  ██╗",
			" ███╗ ██║██╔═══╝██╔═══██╗███╗ ██║",
			" ████╗██║██████╗██║   ██║████╗██║",
			" ██╔████║██╔═══╝██║   ██║██╔████║",
			" ██║╚███║██████╗╚██████╔╝██║╚███║",
			" ╚═╝ ╚══╝╚═════╝ ╚═════╝ ╚═╝ ╚══╝",
		]);
		expect(formatInitBanner()).toBe(INIT_BANNER_LINES.join("\n"));
	});
});

describe("shouldPrintInitBanner", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("is false for -y even on a TTY", () => {
		vi.stubEnv("CI", "false");
		expect(shouldPrintInitBanner(true)).toBe(false);
	});

	test("is false in CI", () => {
		vi.stubEnv("CI", "true");
		expect(shouldPrintInitBanner(false)).toBe(false);
	});
});

describe("printInitBanner", () => {
	test("writes the mark to stdout, not stderr", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		printInitBanner();
		const out = stdout.mock.calls.map((call) => String(call[0])).join("");
		expect(strip(out)).toContain("██████╗");
		expect(strip(out)).toContain(
			"Set up coding agents and this directory for Neon.",
		);
		expect(stderr).not.toHaveBeenCalled();
		stdout.mockRestore();
		stderr.mockRestore();
	});
});

describe("agentSetupDoneLabel", () => {
	test("selected setup that never ran is not run", () => {
		expect(agentSetupDoneLabel({ setup: "plugin", ran: false })).toBe(
			"not run",
		);
		expect(agentSetupDoneLabel({ setup: "skills-mcp", ran: false })).toBe(
			"not run",
		);
	});

	test("skip stays skipped", () => {
		expect(agentSetupDoneLabel({ setup: "skip", ran: false })).toBe(
			"skipped",
		);
	});

	test("a run setup uses the setup label", () => {
		expect(agentSetupDoneLabel({ setup: "plugin", ran: true })).toBe(
			"plugin",
		);
	});
});

describe("formatInitDone", () => {
	test("lists what ran and remaining next steps", () => {
		expect(
			formatInitDone({
				heading: "Project scaffolded.",
				rows: [
					{ label: "Template", value: "Hono API" },
					{ label: "Dependencies", value: "installed with pnpm" },
					{ label: "Project", value: "linked" },
				],
				next: ["cd my-app", "See the README to run it."],
			}),
		).toBe(
			[
				"Project scaffolded.",
				"-------------------",
				"",
				"  Template      Hono API",
				"  Dependencies  installed with pnpm",
				"  Project       linked",
				"",
				"Next:",
				"  cd my-app",
				"  See the README to run it.",
				"",
			].join("\n"),
		);
	});

	test("failed install does not claim the project is ready", () => {
		const text = formatInitDone({
			heading: "Setup did not finish.",
			rows: [
				{ label: "Dependencies", value: "install failed" },
				{ label: "Project", value: "not linked" },
			],
			next: ["pnpm install", "neon link"],
		});
		expect(text).toMatch(/^Setup did not finish\./);
		expect(text).not.toContain("Project scaffolded");
		expect(text).toContain("pnpm install");
	});
});

describe("printInitDone", () => {
	test("writes the summary to stdout without an INFO prefix", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		printInitDone(
			formatInitDone({
				heading: "Project scaffolded.",
				rows: [{ label: "Agents", value: "plugin" }],
				next: [],
			}),
		);
		const out = stdout.mock.calls.map((call) => String(call[0])).join("");
		expect(out).not.toContain("INFO:");
		expect(strip(out)).toContain("Project scaffolded.");
		expect(strip(out)).toContain("Agents");
		expect(stderr).not.toHaveBeenCalled();
		stdout.mockRestore();
		stderr.mockRestore();
	});
});

describe("configSummaryLabel", () => {
	test("names created, skipped, existing, and template configs", () => {
		expect(configSummaryLabel("created")).toBe("neon.ts created");
		expect(configSummaryLabel("skipped")).toBe("skipped");
		expect(configSummaryLabel("existing")).toBe("existing Neon config");
		expect(configSummaryLabel("template")).toBe("provided by template");
	});
});
