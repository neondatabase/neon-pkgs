import { describe, expect, test } from "vitest";

import {
	bootstrapInitStep,
	childArgv,
	directoryIsEmpty,
	planInit,
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
	test("interactive empty dir", () => {
		expect(bootstrapInitStep(false)).toEqual([
			"bootstrap",
			".",
			"--no-link",
		]);
	});

	test("-y empty dir", () => {
		expect(bootstrapInitStep(true)).toEqual([
			"bootstrap",
			".",
			"--default",
			"--no-link",
		]);
	});
});

describe("planInit", () => {
	test("skills-mcp unlinked interactive: skills, link, mcp", () => {
		expect(
			planInit({
				linked: false,
				yes: false,
				agentSetup: "skills-mcp",
			}),
		).toEqual([["skills"], ["link"], ["mcp"]]);
	});

	test("skills-mcp unlinked -y", () => {
		expect(
			planInit({
				linked: false,
				yes: true,
				agentSetup: "skills-mcp",
			}),
		).toEqual([
			["skills", "-y"],
			["link", "--yes"],
			["mcp", "-y"],
		]);
	});

	test("skills-mcp linked: skills and mcp only", () => {
		expect(
			planInit({
				linked: true,
				yes: false,
				agentSetup: "skills-mcp",
			}),
		).toEqual([["skills"], ["mcp"]]);
	});

	test("plugin unlinked interactive: plugins, link", () => {
		expect(
			planInit({
				linked: false,
				yes: false,
				agentSetup: "plugin",
			}),
		).toEqual([["plugins"], ["link"]]);
	});

	test("plugin unlinked -y: plugins -y, link --yes", () => {
		expect(
			planInit({
				linked: false,
				yes: true,
				agentSetup: "plugin",
			}),
		).toEqual([
			["plugins", "-y"],
			["link", "--yes"],
		]);
	});

	test("plugin linked: plugins only", () => {
		expect(
			planInit({
				linked: true,
				yes: false,
				agentSetup: "plugin",
			}),
		).toEqual([["plugins"]]);
	});

	test("skip unlinked: link only", () => {
		expect(
			planInit({
				linked: false,
				yes: false,
				agentSetup: "skip",
			}),
		).toEqual([["link"]]);
	});

	test("skip unlinked -y: link --yes", () => {
		expect(
			planInit({
				linked: false,
				yes: true,
				agentSetup: "skip",
			}),
		).toEqual([["link", "--yes"]]);
	});

	test("skip linked: no steps", () => {
		expect(
			planInit({
				linked: true,
				yes: false,
				agentSetup: "skip",
			}),
		).toEqual([]);
	});

	test("plugin never includes skills or mcp", () => {
		const steps = planInit({
			linked: false,
			yes: true,
			agentSetup: "plugin",
		}).map((step) => step[0]);
		expect(steps).toEqual(["plugins", "link"]);
		expect(steps).not.toContain("skills");
		expect(steps).not.toContain("mcp");
	});

	test("skills-mcp never includes plugins", () => {
		const steps = planInit({
			linked: false,
			yes: true,
			agentSetup: "skills-mcp",
		}).map((step) => step[0]);
		expect(steps).toEqual(["skills", "link", "mcp"]);
		expect(steps).not.toContain("plugins");
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
});
