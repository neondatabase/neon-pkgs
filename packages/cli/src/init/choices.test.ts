import { describe, expect, test } from "vitest";

import {
	configPlanFromResolution,
	INIT_CONFIG_SERVICES_CONFLICT,
	INIT_TEMPLATE_CONFLICT,
	resolveInitConfigChoice,
	resolveInitTemplateChoice,
	shouldRefreshEnvAfterNewConfig,
} from "./choices.js";

describe("resolveInitTemplateChoice", () => {
	test("non-empty is the existing-app path", () => {
		expect(
			resolveInitTemplateChoice({
				empty: false,
				yes: false,
				skipTemplate: false,
			}),
		).toEqual({ kind: "existing" });
	});

	test("--skip-template in a non-empty directory is redundant existing-app", () => {
		expect(
			resolveInitTemplateChoice({
				empty: false,
				yes: true,
				skipTemplate: true,
			}),
		).toEqual({ kind: "existing" });
	});

	test("--template in a non-empty directory fails before mutations", () => {
		expect(() =>
			resolveInitTemplateChoice({
				empty: false,
				yes: false,
				skipTemplate: false,
				template: "hono",
			}),
		).toThrow(/only for an empty directory/);
	});

	test("empty with --skip-template skips scaffolding", () => {
		expect(
			resolveInitTemplateChoice({
				empty: true,
				yes: false,
				skipTemplate: true,
			}),
		).toEqual({ kind: "skip" });
	});

	test("empty -y without --skip-template is the default template", () => {
		expect(
			resolveInitTemplateChoice({
				empty: true,
				yes: true,
				skipTemplate: false,
			}),
		).toEqual({ kind: "default" });
	});

	test("empty -y --skip-template skips scaffolding", () => {
		expect(
			resolveInitTemplateChoice({
				empty: true,
				yes: true,
				skipTemplate: true,
			}),
		).toEqual({ kind: "skip" });
	});

	test("empty --template selects that id", () => {
		expect(
			resolveInitTemplateChoice({
				empty: true,
				yes: false,
				skipTemplate: false,
				template: "hono",
			}),
		).toEqual({ kind: "template", id: "hono" });
	});

	test("empty interactive with no flags asks", () => {
		expect(
			resolveInitTemplateChoice({
				empty: true,
				yes: false,
				skipTemplate: false,
			}),
		).toEqual({ kind: "ask" });
	});

	test("--skip-template and --template together fail", () => {
		expect(() =>
			resolveInitTemplateChoice({
				empty: true,
				yes: false,
				skipTemplate: true,
				template: "hono",
			}),
		).toThrow(INIT_TEMPLATE_CONFLICT);
	});

	test("blank --template is treated as omitted", () => {
		expect(
			resolveInitTemplateChoice({
				empty: true,
				yes: false,
				skipTemplate: false,
				template: "  ",
			}),
		).toEqual({ kind: "ask" });
	});
});

describe("resolveInitConfigChoice", () => {
	test("existing config still runs config init for packages", () => {
		expect(
			resolveInitConfigChoice({
				flag: undefined,
				yes: false,
				canAsk: true,
				existingConfig: true,
			}),
		).toEqual({ kind: "write" });
	});

	test("--no-config skips even when -y would write", () => {
		expect(
			resolveInitConfigChoice({
				flag: false,
				yes: true,
				canAsk: false,
				existingConfig: false,
			}),
		).toEqual({ kind: "skip" });
	});

	test("--no-config skips even when a neon.ts already exists", () => {
		expect(
			resolveInitConfigChoice({
				flag: false,
				yes: true,
				canAsk: false,
				existingConfig: true,
			}),
		).toEqual({ kind: "skip" });
	});

	test("--no-config and --services conflict", () => {
		expect(() =>
			resolveInitConfigChoice({
				flag: false,
				yes: false,
				canAsk: true,
				existingConfig: false,
				services: ["auth"],
			}),
		).toThrow(INIT_CONFIG_SERVICES_CONFLICT);
	});

	test("--services implies consent", () => {
		expect(
			resolveInitConfigChoice({
				flag: undefined,
				yes: false,
				canAsk: true,
				existingConfig: false,
				services: ["auth", "functions"],
			}),
		).toEqual({ kind: "write", services: ["auth", "functions"] });
	});

	test("parsed --services none is write with an empty selection", () => {
		expect(
			resolveInitConfigChoice({
				flag: undefined,
				yes: false,
				canAsk: true,
				existingConfig: false,
				services: [],
			}),
		).toEqual({ kind: "write", services: [] });
	});

	test("--config writes without forcing --services none", () => {
		expect(
			resolveInitConfigChoice({
				flag: true,
				yes: false,
				canAsk: true,
				existingConfig: false,
			}),
		).toEqual({ kind: "write" });
	});

	test("--config -y still uses the starter policy", () => {
		expect(
			resolveInitConfigChoice({
				flag: true,
				yes: true,
				canAsk: false,
				existingConfig: false,
			}),
		).toEqual({ kind: "write", services: ["none"] });
	});

	test("-y writes starter policy", () => {
		expect(
			resolveInitConfigChoice({
				flag: undefined,
				yes: true,
				canAsk: false,
				existingConfig: false,
			}),
		).toEqual({ kind: "write", services: ["none"] });
	});

	test("omitted in a TTY asks once", () => {
		expect(
			resolveInitConfigChoice({
				flag: undefined,
				yes: false,
				canAsk: true,
				existingConfig: false,
			}),
		).toEqual({ kind: "ask" });
	});

	test("omitted without a TTY writes without a services flag", () => {
		expect(
			resolveInitConfigChoice({
				flag: undefined,
				yes: false,
				canAsk: false,
				existingConfig: false,
			}),
		).toEqual({ kind: "write" });
	});
});

describe("configPlanFromResolution", () => {
	test("ask + yes becomes write", () => {
		expect(configPlanFromResolution({ kind: "ask" }, true)).toEqual({
			kind: "write",
		});
	});

	test("ask + no becomes skip", () => {
		expect(configPlanFromResolution({ kind: "ask" }, false)).toEqual({
			kind: "skip",
		});
	});

	test("ask without an answer is skip", () => {
		expect(configPlanFromResolution({ kind: "ask" }, undefined)).toEqual({
			kind: "skip",
		});
	});

	test("write and skip pass through", () => {
		expect(configPlanFromResolution({ kind: "skip" }, true)).toEqual({
			kind: "skip",
		});
		expect(
			configPlanFromResolution(
				{ kind: "write", services: ["none"] },
				false,
			),
		).toEqual({ kind: "write", services: ["none"] });
	});
});

describe("shouldRefreshEnvAfterNewConfig", () => {
	test("only after a new neon.ts on a pinned branch", () => {
		expect(
			shouldRefreshEnvAfterNewConfig({
				wroteNewFile: true,
				projectId: "proj-1",
				branch: "main",
			}),
		).toBe(true);
		expect(
			shouldRefreshEnvAfterNewConfig({
				wroteNewFile: true,
				projectId: "proj-1",
			}),
		).toBe(false);
		expect(
			shouldRefreshEnvAfterNewConfig({
				wroteNewFile: false,
				projectId: "proj-1",
				branch: "main",
			}),
		).toBe(false);
	});
});
