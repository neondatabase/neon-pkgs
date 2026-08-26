import { describe, expect, test } from "vitest";

import { childArgv, directoryIsEmpty, planInit } from "./plan.js";

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

describe("planInit", () => {
	test("empty interactive: bootstrap --no-link, skills, link, mcp", () => {
		expect(planInit({ empty: true, linked: false, yes: false })).toEqual([
			["bootstrap", ".", "--no-link"],
			["skills"],
			["link"],
			["mcp"],
		]);
	});

	test("empty -y: bootstrap --default --no-link, skills, link, mcp", () => {
		expect(planInit({ empty: true, linked: false, yes: true })).toEqual([
			["bootstrap", ".", "--default", "--no-link"],
			["skills", "-y"],
			["link", "--yes"],
			["mcp", "-y"],
		]);
	});

	test("empty interactive already linked skips link", () => {
		expect(planInit({ empty: true, linked: true, yes: false })).toEqual([
			["bootstrap", ".", "--no-link"],
			["skills"],
			["mcp"],
		]);
	});

	test("empty -y already linked skips link", () => {
		expect(planInit({ empty: true, linked: true, yes: true })).toEqual([
			["bootstrap", ".", "--default", "--no-link"],
			["skills", "-y"],
			["mcp", "-y"],
		]);
	});

	test("existing unlinked interactive: skills, link, mcp", () => {
		expect(planInit({ empty: false, linked: false, yes: false })).toEqual([
			["skills"],
			["link"],
			["mcp"],
		]);
	});

	test("existing unlinked -y", () => {
		expect(planInit({ empty: false, linked: false, yes: true })).toEqual([
			["skills", "-y"],
			["link", "--yes"],
			["mcp", "-y"],
		]);
	});

	test("existing linked: skills and mcp only", () => {
		expect(planInit({ empty: false, linked: true, yes: false })).toEqual([
			["skills"],
			["mcp"],
		]);
	});

	test("existing linked -y", () => {
		expect(planInit({ empty: false, linked: true, yes: true })).toEqual([
			["skills", "-y"],
			["mcp", "-y"],
		]);
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
});
