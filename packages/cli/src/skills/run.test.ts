import { describe, expect, test } from "vitest";

import pkg from "../pkg.js";
import {
	npxCommand,
	skillsAddArgs,
	skillsChildEnv,
	skillsMetadata,
	skillsUpdateArgs,
	skillsUpdateDetail,
	skillsUpdateHadNothing,
} from "./run.js";

describe("npxCommand", () => {
	test("quotes metadata JSON", () => {
		expect(
			npxCommand([
				"-y",
				"skills",
				"add",
				"--metadata",
				'{"origin":"neon-cli"}',
			]),
		).toBe(`npx -y skills add --metadata '{"origin":"neon-cli"}'`);
	});

	test("quotes * so a pasted retry does not glob", () => {
		expect(npxCommand(["-y", "skills", "add", "--skill", "*"])).toBe(
			"npx -y skills add --skill '*'",
		);
	});
});

describe("skillsMetadata", () => {
	test("tags the neon CLI as the origin", () => {
		expect(JSON.parse(skillsMetadata("skills"))).toEqual({
			origin: "neon-cli",
			command: "skills",
			version: pkg.version,
		});
	});
});

describe("skillsChildEnv", () => {
	test("drops telemetry blockers and keeps the rest", () => {
		const env = skillsChildEnv({
			PATH: "/usr/bin",
			HOME: "/tmp/home",
			DISABLE_TELEMETRY: "1",
			DO_NOT_TRACK: "1",
			CI: "true",
		});
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/tmp/home");
		expect(env.CI).toBe("true");
		expect(env).not.toHaveProperty("DISABLE_TELEMETRY");
		expect(env).not.toHaveProperty("DO_NOT_TRACK");
	});
});

describe("skillsAddArgs", () => {
	test("installs all agent-skills into mapped agents", () => {
		const args = skillsAddArgs({
			source: "neondatabase/agent-skills",
			skills: "*",
			agents: ["cursor", "claude-code"],
			global: false,
			metadata: '{"origin":"neon-cli"}',
		});
		expect(args).toEqual([
			"-y",
			"skills",
			"add",
			"neondatabase/agent-skills",
			"--skill",
			"*",
			"--agent",
			"cursor",
			"--agent",
			"claude-code",
			"-y",
			"--metadata",
			'{"origin":"neon-cli"}',
		]);
		expect(args.filter((part) => part === "*")).toEqual(["*"]);
		expect(args.join(" ")).not.toMatch(/--agent \*/);
	});

	test("passes -g for user-level installs", () => {
		expect(
			skillsAddArgs({
				source: "neondatabase/agent-skills",
				skills: ["neon"],
				agents: ["cursor"],
				global: true,
				metadata: "{}",
			}),
		).toContain("-g");
	});

	test("rejects an empty skill list", () => {
		expect(() =>
			skillsAddArgs({
				source: "neondatabase/agent-skills",
				skills: [],
				agents: ["cursor"],
				global: false,
				metadata: "{}",
			}),
		).toThrow(/at least one --skill/);
	});
});

describe("skillsUpdateHadNothing", () => {
	test("reads the skills CLI no-op lines", () => {
		expect(
			skillsUpdateHadNothing(
				"Checking for skill updates…\nNo project skills to update.",
			),
		).toBe(true);
		expect(
			skillsUpdateHadNothing(
				"Checking for skill updates…\nNo global skills tracked in lock file.",
			),
		).toBe(true);
		expect(
			skillsUpdateHadNothing("✓ All global skills are up to date"),
		).toBe(true);
		expect(skillsUpdateHadNothing("✓ Updated 1 skill(s)")).toBe(false);
	});
});

describe("skillsUpdateDetail", () => {
	test("takes the result line, not the progress banner", () => {
		expect(
			skillsUpdateDetail(
				"\u001b[38;5;145mChecking for skill updates…\u001b[0m\nNo project skills to update.\n",
			),
		).toBe("No project skills to update.");
		expect(
			skillsUpdateDetail(
				"Checking for skill updates…\nNo global skills tracked in lock file.\nInstall skills with npx skills add -g\n",
			),
		).toBe("No global skills tracked in lock file.");
		expect(
			skillsUpdateDetail(
				"Checking for skill updates…\nUpdating for: Universal\nRefreshing 1 skill(s)…\nUpdating neon…\n  ✓ Updated neon\n✓ Updated 1 skill(s)\n",
			),
		).toBe("✓ Updated 1 skill(s)");
	});

	test("returns undefined when only the banner is present", () => {
		expect(skillsUpdateDetail("Checking for skill updates…\n")).toBe(
			undefined,
		);
	});
});

describe("skillsUpdateArgs", () => {
	test("defaults to project scope", () => {
		expect(skillsUpdateArgs({ global: false })).toEqual([
			"-y",
			"skills",
			"update",
			"-p",
			"-y",
		]);
	});

	test("uses -g for user-level updates", () => {
		expect(skillsUpdateArgs({ global: true })).toEqual([
			"-y",
			"skills",
			"update",
			"-g",
			"-y",
		]);
	});
});
