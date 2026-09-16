import { describe, expect, test } from "vitest";
import {
	authoredAiGateway,
	authoredBuckets,
	authoredFunctions,
	authoredFunctionTuning,
	deprecatedPreviewAuthoring,
	mergeAuthoredPreview,
	previewGaWarningForConfig,
	previewGaWarningMessage,
} from "./authored-services.js";
import { defineConfig } from "./define-config.js";

describe("authored service homes", () => {
	test("prefers the GA home when both could exist (collision is rejected earlier)", () => {
		const config = defineConfig({
			functions: { hello: { name: "Hello", source: "./hello.ts" } },
			buckets: { uploads: {} },
			aiGateway: true,
		});
		expect(authoredFunctions(config)?.hello?.name).toBe("Hello");
		expect(authoredBuckets(config)?.uploads).toEqual({});
		expect(authoredAiGateway(config)).toBe(true);
	});

	test("reads deprecated preview homes", () => {
		const config = defineConfig({
			preview: {
				functions: { hello: { name: "Hello", source: "./hello.ts" } },
				buckets: { uploads: {} },
				aiGateway: true,
			},
		});
		expect(authoredFunctions(config)?.hello?.name).toBe("Hello");
		expect(authoredBuckets(config)?.uploads).toEqual({});
		expect(authoredAiGateway(config)).toBe(true);
	});

	test("mergeAuthoredPreview folds GA keys into the resolve shape", () => {
		const config = defineConfig({
			functions: { hello: { name: "Hello", source: "./hello.ts" } },
			aiGateway: true,
		});
		expect(mergeAuthoredPreview(config)).toEqual({
			functions: { hello: { name: "Hello", source: "./hello.ts" } },
			aiGateway: true,
		});
	});

	test("an empty preview object contributes no deprecated keys", () => {
		const config = defineConfig({ preview: {} });
		expect(deprecatedPreviewAuthoring(config)).toEqual([]);
		expect(mergeAuthoredPreview(config)).toEqual({});
	});

	test("lists each deprecated preview path still authored", () => {
		const config = defineConfig({
			preview: {
				aiGateway: true,
				functions: { hello: { name: "Hello", source: "./hello.ts" } },
				buckets: { uploads: {} },
			},
		});
		expect(deprecatedPreviewAuthoring(config)).toEqual([
			"preview.aiGateway",
			"preview.functions",
			"preview.buckets",
		]);
	});

	test("lists deprecated branch.preview.functions tuning", () => {
		expect(
			deprecatedPreviewAuthoring(
				{},
				{ preview: { functions: { hello: { runtime: "nodejs24" } } } },
			),
		).toEqual(["branch.preview.functions"]);
	});

	test("GA branch.functions tuning is not deprecated", () => {
		expect(
			deprecatedPreviewAuthoring(
				{},
				{ functions: { hello: { runtime: "nodejs24" } } },
			),
		).toEqual([]);
	});

	test("authoredFunctionTuning prefers the GA home", () => {
		expect(
			authoredFunctionTuning({
				functions: { hello: { runtime: "nodejs24" } },
			}),
		).toEqual({ hello: { runtime: "nodejs24" } });
		expect(
			authoredFunctionTuning({
				preview: { functions: { hello: { runtime: "nodejs24" } } },
			}),
		).toEqual({ hello: { runtime: "nodejs24" } });
	});
});

describe("previewGaWarningMessage", () => {
	test("names each deprecated path and its GA replacement", () => {
		expect(
			previewGaWarningMessage([
				"preview.aiGateway",
				"preview.functions",
				"preview.buckets",
				"branch.preview.functions",
			]),
		).toBe(
			"These neon.ts keys are now GA and can be lifted out of preview: preview.aiGateway → aiGateway, preview.functions → functions, preview.buckets → buckets, branch.preview.functions → branch.functions.",
		);
	});
});

describe("previewGaWarningForConfig", () => {
	test("returns null when nothing is deprecated", () => {
		expect(previewGaWarningForConfig(defineConfig({}))).toBeNull();
		expect(
			previewGaWarningForConfig(
				defineConfig({
					functions: {
						hello: { name: "Hello", source: "./hello.ts" },
					},
					aiGateway: true,
					buckets: { uploads: {} },
					branch: () => ({
						functions: { hello: { runtime: "nodejs24" } },
					}),
				}),
			),
		).toBeNull();
		expect(
			previewGaWarningForConfig(defineConfig({ preview: {} })),
		).toBeNull();
	});

	test("warns for static preview keys", () => {
		const message = previewGaWarningForConfig(
			defineConfig({
				preview: {
					aiGateway: true,
					functions: {
						hello: { name: "Hello", source: "./hello.ts" },
					},
					buckets: { uploads: {} },
				},
			}),
		);
		expect(message).toContain("preview.aiGateway → aiGateway");
		expect(message).toContain("preview.functions → functions");
		expect(message).toContain("preview.buckets → buckets");
	});

	test("warns for child-only branch.preview.functions tuning", () => {
		const message = previewGaWarningForConfig(
			defineConfig({
				functions: {
					hello: { name: "Hello", source: "./hello.ts" },
				},
				branch: (branch) =>
					branch.isDefault
						? {}
						: {
								preview: {
									functions: {
										hello: { runtime: "nodejs24" },
									},
								},
							},
			}),
		);
		expect(message).toContain(
			"branch.preview.functions → branch.functions",
		);
	});
});
