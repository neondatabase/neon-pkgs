import { describe, expect, test } from "vitest";

import {
	configPlanFromResolution,
	INIT_CONFIG_SERVICES_CONFLICT,
	initEnvPullAfterConfig,
	resolveInitConfigChoice,
} from "./choices.js";

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
		).toEqual({ kind: "write", services: ["postgres"] });
	});

	test("-y writes starter policy", () => {
		expect(
			resolveInitConfigChoice({
				flag: undefined,
				yes: true,
				canAsk: false,
				existingConfig: false,
			}),
		).toEqual({ kind: "write", services: ["postgres"] });
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
				{ kind: "write", services: ["postgres"] },
				false,
			),
		).toEqual({ kind: "write", services: ["postgres"] });
	});
});

describe("initEnvPullAfterConfig", () => {
	const pinned = { projectId: "proj-1", branch: "main" };

	test("pulls from neon.ts after a link that deferred its pull", () => {
		expect(
			initEnvPullAfterConfig({
				linkDeferredPull: true,
				wroteNewFile: true,
				declared: ["ai-gateway", "functions"],
				claimable: false,
				...pinned,
			}),
		).toEqual({ kind: "policy" });
	});

	test("still pulls after a deferred link when neon.ts was declined", () => {
		expect(
			initEnvPullAfterConfig({
				linkDeferredPull: true,
				wroteNewFile: false,
				declared: [],
				claimable: false,
				...pinned,
			}),
		).toEqual({ kind: "policy" });
	});

	test("pulls only deploy-free services while others await a deploy", () => {
		expect(
			initEnvPullAfterConfig({
				linkDeferredPull: true,
				wroteNewFile: true,
				declared: ["auth", "ai-gateway", "functions"],
				claimable: false,
				...pinned,
			}),
		).toEqual({
			kind: "services",
			services: ["postgres", "ai-gateway"],
			envKeys: ["NEON_FUNCTION_HELLO_BASE_URL"],
		});
		expect(
			initEnvPullAfterConfig({
				linkDeferredPull: false,
				wroteNewFile: true,
				declared: ["object-storage"],
				claimable: false,
				...pinned,
			}),
		).toEqual({ kind: "services", services: ["postgres"], envKeys: [] });
	});

	test("skips when nothing changed since an earlier pull", () => {
		expect(
			initEnvPullAfterConfig({
				linkDeferredPull: false,
				wroteNewFile: false,
				declared: [],
				claimable: false,
				...pinned,
			}),
		).toEqual({ kind: "skip" });
	});

	test("skips a claimable project whose neon.ts declares extra services", () => {
		expect(
			initEnvPullAfterConfig({
				linkDeferredPull: false,
				wroteNewFile: true,
				declared: ["ai-gateway"],
				claimable: true,
				...pinned,
			}),
		).toEqual({ kind: "skip" });
	});

	test("skips without a pinned branch", () => {
		expect(
			initEnvPullAfterConfig({
				linkDeferredPull: true,
				wroteNewFile: true,
				declared: [],
				claimable: false,
				projectId: "proj-1",
			}),
		).toEqual({ kind: "skip" });
	});
});
