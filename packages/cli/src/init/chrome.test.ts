import strip from "strip-ansi";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	formatInitBanner,
	formatInitDone,
	INIT_BANNER_LINES,
	printInitBanner,
	printInitDone,
	shouldPrintInitBanner,
} from "./chrome.js";

describe("formatInitBanner", () => {
	test("is the six-line NEON mark", () => {
		expect(formatInitBanner()).toBe(INIT_BANNER_LINES.join("\n"));
		expect(formatInitBanner().split("\n")).toHaveLength(6);
		expect(formatInitBanner()).toContain("██████╗");
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
			"Let's get this directory set up with Neon.",
		);
		expect(stderr).not.toHaveBeenCalled();
		stdout.mockRestore();
		stderr.mockRestore();
	});
});

describe("formatInitDone", () => {
	test("lists what ran and remaining next steps", () => {
		expect(
			formatInitDone({
				heading: "Neon is ready.",
				rows: [
					{ label: "Template", value: "Hono API" },
					{ label: "Dependencies", value: "installed with pnpm" },
					{ label: "Project", value: "linked" },
				],
				next: ["cd my-app", "See the README to run it."],
			}),
		).toBe(
			[
				"Neon is ready.",
				"--------------",
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
		expect(text).not.toContain("Neon is ready");
		expect(text).toContain("pnpm install");
	});
});

describe("printInitDone", () => {
	test("writes the summary to stdout without an INFO prefix", () => {
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		printInitDone(
			formatInitDone({
				heading: "Neon is ready.",
				rows: [{ label: "Agents", value: "plugin" }],
				next: [],
			}),
		);
		const out = stdout.mock.calls.map((call) => String(call[0])).join("");
		expect(out).not.toContain("INFO:");
		expect(strip(out)).toContain("Neon is ready.");
		expect(strip(out)).toContain("Agents");
		expect(stderr).not.toHaveBeenCalled();
		stdout.mockRestore();
		stderr.mockRestore();
	});
});
