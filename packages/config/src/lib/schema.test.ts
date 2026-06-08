import { describe, expect, test } from "vitest";
import {
	branchConfigSchema,
	computeSettingsSchema,
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

describe("branchConfigSchema", () => {
	test("accepts branch-level lifecycle and product namespaces", () => {
		expect(
			branchConfigSchema.parse({
				parent: "main",
				ttl: "7d",
				postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
				auth: { enabled: true },
			}),
		).toMatchObject({ parent: "main", auth: { enabled: true } });
	});

	test("rejects wildcard parent", () => {
		const result = branchConfigSchema.safeParse({ parent: "preview-*" });
		expect(result.success).toBe(false);
	});

	test("accepts a preview block with functions, buckets, and aiGateway", () => {
		const result = branchConfigSchema.safeParse({
			preview: {
				functions: [
					{
						slug: "fn1",
						name: "Hello World",
						source: "./hello.ts",
						env: { KEY: "value" },
					},
				],
				buckets: [{ name: "uploads", access: "public_read" }],
				aiGateway: { enabled: true },
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects an unknown key inside preview", () => {
		const result = branchConfigSchema.safeParse({
			preview: { functions: [], typo: true },
		});
		expect(result.success).toBe(false);
	});

	test("accepts a function dev block with port and portless", () => {
		const result = branchConfigSchema.safeParse({
			preview: {
				functions: [
					{
						slug: "fn1",
						name: "Hello World",
						source: "./hello.ts",
						dev: { port: 8787, portless: true },
					},
				],
			},
		});
		expect(result.success).toBe(true);
	});

	test("accepts dev with no port when portless is not set", () => {
		const result = branchConfigSchema.safeParse({
			preview: {
				functions: [
					{ slug: "f", name: "F", source: "./f.ts", dev: {} },
				],
			},
		});
		expect(result.success).toBe(true);
	});

	test("accepts dev.portless true without a port (portless assigns the port)", () => {
		const result = branchConfigSchema.safeParse({
			preview: {
				functions: [
					{
						slug: "f",
						name: "F",
						source: "./f.ts",
						dev: { portless: true },
					},
				],
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects an out-of-range dev.port", () => {
		const result = branchConfigSchema.safeParse({
			preview: {
				functions: [
					{
						slug: "f",
						name: "F",
						source: "./f.ts",
						dev: { port: 0 },
					},
				],
			},
		});
		expect(result.success).toBe(false);
	});

	test("rejects an unknown key inside dev", () => {
		const result = branchConfigSchema.safeParse({
			preview: {
				functions: [
					{
						slug: "f",
						name: "F",
						source: "./f.ts",
						dev: { port: 8787, typo: true },
					},
				],
			},
		});
		expect(result.success).toBe(false);
	});
});

describe("formatZodIssues", () => {
	test("renders paths", () => {
		const result = branchConfigSchema.safeParse({
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
