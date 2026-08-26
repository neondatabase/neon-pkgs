import { describe, expect, test } from "vitest";

import {
	bootstrapInitStep,
	childArgv,
	directoryIsEmpty,
	planAgentSteps,
	planExistingInit,
	projectContextFile,
	resolveInitAgentSetup,
} from "./plan.js";

describe("directoryIsEmpty", () => {
	test("treats an empty list as empty", () => {
		expect(directoryIsEmpty([])).toBe(true);
	});

	test("ignores .git", () => {
		expect(directoryIsEmpty([".git"])).toBe(true);
	});

	test("a README is not empty", () => {
		expect(directoryIsEmpty(["README.md"])).toBe(false);
	});

	test(".git plus anything else is not empty", () => {
		expect(directoryIsEmpty([".git", "package.json"])).toBe(false);
	});
});

describe("bootstrapInitStep", () => {
	test("interactive empty dir is bootstrap .", () => {
		expect(bootstrapInitStep(false)).toEqual(["bootstrap", "."]);
	});

	test("-y empty dir is bootstrap . --default", () => {
		expect(bootstrapInitStep(true)).toEqual([
			"bootstrap",
			".",
			"--default",
		]);
	});
});

describe("projectContextFile", () => {
	test("an absolute parent context file does not follow into the scaffold", () => {
		expect(
			projectContextFile("/tmp/my-app", "/Users/me/project/.neon"),
		).toBe("/tmp/my-app/.neon");
	});

	test("a relative context file is resolved against the scaffold", () => {
		expect(projectContextFile("/tmp/my-app", ".neon")).toBe(
			"/tmp/my-app/.neon",
		);
	});
});

describe("planAgentSteps", () => {
	test("plugin never includes skills or mcp", () => {
		expect(planAgentSteps({ yes: true, agentSetup: "plugin" })).toEqual([
			["plugins", "-y"],
		]);
	});

	test("skills-mcp never includes plugins", () => {
		expect(planAgentSteps({ yes: true, agentSetup: "skills-mcp" })).toEqual(
			[
				["skills", "-y"],
				["mcp", "-y"],
			],
		);
	});

	test("skip is empty", () => {
		expect(planAgentSteps({ yes: false, agentSetup: "skip" })).toEqual([]);
	});
});

describe("planExistingInit", () => {
	test("skills-mcp unlinked interactive: skills, mcp, link, config init", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: false,
				agentSetup: "skills-mcp",
			}),
		).toEqual([["skills"], ["mcp"], ["link"], ["config", "init"]]);
	});

	test("skills-mcp unlinked -y", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: true,
				agentSetup: "skills-mcp",
			}),
		).toEqual([
			["skills", "-y"],
			["mcp", "-y"],
			["link", "--yes"],
			["config", "init", "--services", "none"],
		]);
	});

	test("skills-mcp linked: skills, mcp, config init", () => {
		expect(
			planExistingInit({
				linked: true,
				yes: false,
				agentSetup: "skills-mcp",
			}),
		).toEqual([["skills"], ["mcp"], ["config", "init"]]);
	});

	test("plugin unlinked interactive: plugins, link, config init", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: false,
				agentSetup: "plugin",
			}),
		).toEqual([["plugins"], ["link"], ["config", "init"]]);
	});

	test("plugin unlinked -y", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: true,
				agentSetup: "plugin",
			}),
		).toEqual([
			["plugins", "-y"],
			["link", "--yes"],
			["config", "init", "--services", "none"],
		]);
	});

	test("plugin linked: plugins and config init", () => {
		expect(
			planExistingInit({
				linked: true,
				yes: false,
				agentSetup: "plugin",
			}),
		).toEqual([["plugins"], ["config", "init"]]);
	});

	test("skip unlinked: link and config init", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: false,
				agentSetup: "skip",
			}),
		).toEqual([["link"], ["config", "init"]]);
	});

	test("skip unlinked -y", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: true,
				agentSetup: "skip",
			}),
		).toEqual([
			["link", "--yes"],
			["config", "init", "--services", "none"],
		]);
	});

	test("skip linked: config init only", () => {
		expect(
			planExistingInit({
				linked: true,
				yes: false,
				agentSetup: "skip",
			}),
		).toEqual([["config", "init"]]);
	});
});

describe("resolveInitAgentSetup", () => {
	const pickUnused = async () => {
		throw new Error("pick should not run");
	};

	test("-y uses plugin when a project plugin agent is present", async () => {
		await expect(
			resolveInitAgentSetup({
				yes: true,
				interactive: false,
				hasProjectPlugins: true,
				pick: pickUnused,
			}),
		).resolves.toBe("plugin");
	});

	test("-y falls back to skills-mcp when none are present", async () => {
		await expect(
			resolveInitAgentSetup({
				yes: true,
				interactive: false,
				hasProjectPlugins: false,
				pick: pickUnused,
			}),
		).resolves.toBe("skills-mcp");
	});

	test("-y ignores interactive pick", async () => {
		await expect(
			resolveInitAgentSetup({
				yes: true,
				interactive: true,
				hasProjectPlugins: false,
				pick: async () => "plugin",
			}),
		).resolves.toBe("skills-mcp");
	});

	test("interactive uses pick", async () => {
		await expect(
			resolveInitAgentSetup({
				yes: false,
				interactive: true,
				hasProjectPlugins: true,
				pick: async () => "skip",
			}),
		).resolves.toBe("skip");
	});

	test("no TTY and no -y keeps skills-mcp", async () => {
		await expect(
			resolveInitAgentSetup({
				yes: false,
				interactive: false,
				hasProjectPlugins: true,
				pick: pickUnused,
			}),
		).resolves.toBe("skills-mcp");
	});
});

describe("childArgv", () => {
	const host = "https://console.neon.tech/api/v2";

	test("forwards account and context, not --output", () => {
		expect(
			childArgv(["skills", "-y"], {
				configDir: "/cfg",
				profile: "work",
				apiHost: host,
				contextFile: "/app/.neon",
				analytics: false,
			}),
		).toEqual([
			"skills",
			"-y",
			"--config-dir",
			"/cfg",
			"--profile",
			"work",
			"--api-host",
			host,
			"--context-file",
			"/app/.neon",
			"--no-analytics",
		]);
	});

	test("omits optional flags when unset", () => {
		expect(
			childArgv(["mcp"], {
				apiHost: host,
				contextFile: "/app/.neon",
			}),
		).toEqual(["mcp", "--api-host", host, "--context-file", "/app/.neon"]);
	});

	test("forwards globals onto plugins", () => {
		expect(
			childArgv(["plugins", "-y"], {
				apiHost: host,
				contextFile: "/app/.neon",
			}),
		).toEqual([
			"plugins",
			"-y",
			"--api-host",
			host,
			"--context-file",
			"/app/.neon",
		]);
	});

	test("forwards --services none onto config init", () => {
		expect(
			childArgv(["config", "init", "--services", "none"], {
				apiHost: host,
				contextFile: "/app/.neon",
			}),
		).toEqual([
			"config",
			"init",
			"--services",
			"none",
			"--api-host",
			host,
			"--context-file",
			"/app/.neon",
		]);
	});
});
