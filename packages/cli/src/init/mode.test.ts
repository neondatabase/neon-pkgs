import { describe, expect, test } from "vitest";
import { NO_AGENT_SETUP_CONFLICT, NON_TTY_AGENT_SETUP } from "./copy.js";
import {
	assertAgentSetupFlags,
	inferInitAgentSetup,
	resolveInitMode,
} from "./mode.js";
import { INIT_NEEDS_YES_OR_TERMINAL } from "./plan.js";

const base = {
	yes: false,
	interactive: false,
	skipAgents: false,
	namedAgents: false,
	noLink: false,
	hasLinkInputs: false,
	claimable: false,
} as const;

describe("resolveInitMode", () => {
	test("-y selects recommended", () => {
		expect(resolveInitMode({ ...base, yes: true })).toEqual({
			kind: "recommended",
		});
	});

	test("-y with --skill selects custom", () => {
		expect(
			resolveInitMode({ ...base, yes: true, skills: ["neon"] }),
		).toEqual({ kind: "custom" });
	});

	test("-y with --mcp-config-location selects custom", () => {
		expect(
			resolveInitMode({
				...base,
				yes: true,
				mcpConfigLocation: "project",
			}),
		).toEqual({ kind: "custom" });
	});

	test("-y with --mcp-project-scoped selects custom", () => {
		expect(
			resolveInitMode({
				...base,
				yes: true,
				mcpProjectScoped: true,
			}),
		).toEqual({ kind: "custom" });
	});

	test("-y with --no-agent-setup selects custom", () => {
		expect(
			resolveInitMode({ ...base, yes: true, skipAgents: true }),
		).toEqual({ kind: "custom" });
	});

	test("-y with --claimable selects custom", () => {
		expect(
			resolveInitMode({ ...base, yes: true, claimable: true }),
		).toEqual({ kind: "custom" });
	});

	test("-y --agent stays recommended", () => {
		expect(
			resolveInitMode({ ...base, yes: true, namedAgents: true }),
		).toEqual({ kind: "recommended" });
	});

	test("--no-agent-setup selects custom", () => {
		expect(resolveInitMode({ ...base, skipAgents: true })).toEqual({
			kind: "custom",
		});
	});

	test("named agents without a TTY select custom", () => {
		expect(resolveInitMode({ ...base, namedAgents: true })).toEqual({
			kind: "custom",
		});
	});

	test("--no-link without a TTY selects custom", () => {
		expect(resolveInitMode({ ...base, noLink: true })).toEqual({
			kind: "custom",
		});
	});

	test("--config without a TTY selects custom", () => {
		expect(resolveInitMode({ ...base, configFlag: true })).toEqual({
			kind: "custom",
		});
	});

	test("named agents on a TTY select custom", () => {
		expect(
			resolveInitMode({
				...base,
				interactive: true,
				namedAgents: true,
			}),
		).toEqual({ kind: "custom" });
	});

	test("--no-link on a TTY selects custom", () => {
		expect(
			resolveInitMode({
				...base,
				interactive: true,
				noLink: true,
			}),
		).toEqual({ kind: "custom" });
	});

	test("a TTY with no flags asks", () => {
		expect(resolveInitMode({ ...base, interactive: true })).toEqual({
			kind: "ask",
		});
	});

	test("non-TTY with no flags fails", () => {
		expect(() => resolveInitMode({ ...base })).toThrow(
			INIT_NEEDS_YES_OR_TERMINAL,
		);
	});
});

describe("inferInitAgentSetup", () => {
	const inferBase = {
		skipAgents: false,
		hasMcpFlags: false,
		namedAgents: false,
		yes: false,
		canAsk: false,
	} as const;

	test("--no-agent-setup skips", () => {
		expect(inferInitAgentSetup({ ...inferBase, skipAgents: true })).toEqual(
			{ kind: "skip" },
		);
	});

	test("--skill without MCP is skills only", () => {
		expect(inferInitAgentSetup({ ...inferBase, skills: ["neon"] })).toEqual(
			{ kind: "skills" },
		);
	});

	test("--skill plus MCP flags is skills and MCP", () => {
		expect(
			inferInitAgentSetup({
				...inferBase,
				skills: ["neon"],
				hasMcpFlags: true,
			}),
		).toEqual({ kind: "skills-mcp" });
	});

	test("MCP flags without --skill is skills and MCP", () => {
		expect(
			inferInitAgentSetup({ ...inferBase, hasMcpFlags: true }),
		).toEqual({ kind: "skills-mcp" });
	});

	test("named agents without skill or MCP split plugin vs skills", () => {
		expect(
			inferInitAgentSetup({ ...inferBase, namedAgents: true }),
		).toEqual({ kind: "auto" });
	});

	test("Custom -y without agent flags uses detected tooling", () => {
		expect(inferInitAgentSetup({ ...inferBase, yes: true })).toEqual({
			kind: "auto",
		});
	});

	test("a TTY with no agent flags asks", () => {
		expect(inferInitAgentSetup({ ...inferBase, canAsk: true })).toEqual({
			kind: "ask",
		});
	});

	test("non-TTY Custom without agent flags names the flags", () => {
		expect(() => inferInitAgentSetup(inferBase)).toThrow(
			NON_TTY_AGENT_SETUP,
		);
	});
});

describe("assertAgentSetupFlags", () => {
	test("--no-agent-setup with --skill fails", () => {
		expect(() =>
			assertAgentSetupFlags({
				skipAgents: true,
				namedAgents: false,
				skills: ["neon"],
			}),
		).toThrow(NO_AGENT_SETUP_CONFLICT);
	});

	test("--no-agent-setup alone is allowed", () => {
		expect(() =>
			assertAgentSetupFlags({
				skipAgents: true,
				namedAgents: false,
			}),
		).not.toThrow();
	});
});
