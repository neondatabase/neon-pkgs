import { describe, expect, test } from "vitest";
import {
	branchTuningSchema,
	computeSettingsSchema,
	configInputSchema,
	formatZodIssues,
} from "./schema.js";

describe("computeSettingsSchema", () => {
	test("accepts valid compute settings", () => {
		expect(
			computeSettingsSchema.parse({
				autoscalingLimitMinCu: 0.25,
				autoscalingLimitMaxCu: 2,
			}),
		).toEqual({
			autoscalingLimitMinCu: 0.25,
			autoscalingLimitMaxCu: 2,
		});
	});

	test("rejects min greater than max", () => {
		const result = computeSettingsSchema.safeParse({
			autoscalingLimitMinCu: 4,
			autoscalingLimitMaxCu: 1,
		});
		expect(result.success).toBe(false);
	});
});

describe("configInputSchema", () => {
	test("accepts top-level services, a preview block, and a branch closure", () => {
		const result = configInputSchema.safeParse({
			auth: true,
			dataApi: { enabled: false },
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: "./hello.ts",
						env: { KEY: "value" },
					},
				},
				buckets: { uploads: { access: "public_read" } },
				aiGateway: { enabled: true },
			},
			branch: () => ({}),
		});
		expect(result.success).toBe(true);
	});

	test("rejects an invalid function slug used as a record key", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: { "Bad Slug": { name: "x", source: "./x.ts" } },
			},
		});
		expect(result.success).toBe(false);
	});

	test("surfaces the slug rule (not zod's generic message) for a bad function key", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					"hello-world": { name: "hello", source: "./x.ts" },
				},
			},
		});
		if (result.success) throw new Error("expected failure");
		const formatted = formatZodIssues(result.error).join("\n");
		// Points at the exact offending key…
		expect(formatted).toContain("preview.functions.hello-world");
		// …and explains *why* it is rejected, instead of zod's opaque default.
		expect(formatted).toContain(
			"function slug must be 1-20 lowercase letters and digits (no hyphens or other characters)",
		);
		expect(formatted).not.toContain("Invalid key in record");
	});

	test("rejects an unknown key inside preview", () => {
		const result = configInputSchema.safeParse({
			preview: { functions: {}, typo: true },
		});
		expect(result.success).toBe(false);
	});

	test("accepts a function dev block with a port", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: "./hello.ts",
						dev: { port: 8787 },
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects an unknown key in the function dev block (e.g. removed `portless`)", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: "./hello.ts",
						dev: { portless: true },
					},
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("rejects an out-of-range dev.port", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					f: { name: "F", source: "./f.ts", dev: { port: 0 } },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("rejects an unknown key inside dev", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					f: {
						name: "F",
						source: "./f.ts",
						dev: { port: 8787, typo: true },
					},
				},
			},
		});
		expect(result.success).toBe(false);
	});
});

describe("branchTuningSchema", () => {
	test("accepts branch lifecycle, postgres, and per-function runtime tuning", () => {
		expect(
			branchTuningSchema.parse({
				parent: "main",
				ttl: "7d",
				protected: true,
				postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
				preview: { functions: { hello: { runtime: "nodejs24" } } },
			}),
		).toMatchObject({ parent: "main", protected: true });
	});

	test("rejects function memory tuning", () => {
		const result = branchTuningSchema.safeParse({
			preview: { functions: { hello: { memoryMib: 1024 } } },
		});
		expect(result.success).toBe(false);
	});

	test("rejects wildcard parent", () => {
		const result = branchTuningSchema.safeParse({ parent: "preview-*" });
		expect(result.success).toBe(false);
	});
});

describe("formatZodIssues", () => {
	test("renders paths", () => {
		const result = branchTuningSchema.safeParse({
			postgres: {
				computeSettings: {
					autoscalingLimitMinCu: 8,
					autoscalingLimitMaxCu: 1,
				},
			},
		});
		if (result.success) throw new Error("expected failure");
		expect(formatZodIssues(result.error).join("\n")).toContain(
			"postgres.computeSettings.autoscalingLimitMinCu",
		);
	});
});
