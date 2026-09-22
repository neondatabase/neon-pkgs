import { describe, expect, test } from "vitest";
import { YES_SELECTS_RECOMMENDED } from "./copy.js";
import { resolveInitMode } from "./mode.js";
import { INIT_NEEDS_YES_OR_TERMINAL } from "./plan.js";

const base = {
	yes: false,
	interactive: false,
	namedAgents: false,
	noLink: false,
	hasLinkInputs: false,
} as const;

describe("resolveInitMode", () => {
	test("-y selects recommended", () => {
		expect(resolveInitMode({ ...base, yes: true })).toEqual({
			kind: "recommended",
		});
	});

	test("--mode recommended selects recommended", () => {
		expect(
			resolveInitMode({
				...base,
				interactive: true,
				mode: "recommended",
			}),
		).toEqual({ kind: "recommended" });
	});

	test("-y with --mode custom fails", () => {
		expect(() =>
			resolveInitMode({ ...base, yes: true, mode: "custom" }),
		).toThrow(YES_SELECTS_RECOMMENDED);
	});

	test("--agent-setup selects custom", () => {
		expect(resolveInitMode({ ...base, agentSetup: "skip" })).toEqual({
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
