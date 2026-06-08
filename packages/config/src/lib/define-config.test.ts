import { describe, expect, test } from "vitest";
import { defineConfig, resolveConfig } from "./define-config.js";
import { ConfigValidationError } from "./errors.js";

describe("defineConfig", () => {
	test("accepts a branch policy function and preserves literal behavior", () => {
		const config = defineConfig((branch) => {
			if (branch.name === "main")
				return { protected: true, auth: { enabled: true } };
			return { parent: "main", ttl: "7d" };
		});
		expect(typeof config).toBe("function");
		expect(config({ name: "main", exists: true })).toEqual({
			protected: true,
			auth: { enabled: true },
		});
	});

	test("rejects object configs so project-level config is not accepted", () => {
		expect(() => defineConfig({ project: { name: "x" } } as never)).toThrow(
			ConfigValidationError,
		);
	});
});

describe("resolveConfig", () => {
	test("normalizes branch policy output", () => {
		const config = defineConfig(() => ({
			parent: "main",
			ttl: "1h",
			protected: true,
			postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
			auth: {},
			dataApi: {},
		}));
		const resolved = resolveConfig(config, {
			name: "dev-a",
			exists: false,
		});
		expect(resolved).toMatchObject({
			parent: "main",
			ttlSeconds: 3600,
			protected: true,
			authEnabled: true,
			dataApiEnabled: true,
			postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
		});
	});

	test("treats explicit service false as disabled", () => {
		const config = defineConfig(() => ({
			auth: { enabled: false },
			dataApi: { enabled: false },
		}));
		const resolved = resolveConfig(config, {
			name: "dev-a",
			exists: false,
		});
		expect(resolved.authEnabled).toBe(false);
		expect(resolved.dataApiEnabled).toBe(false);
	});

	test("reports invalid returned branch config", () => {
		const config = defineConfig(() => ({ parent: "preview-*" }));
		expect(() =>
			resolveConfig(config, { name: "dev", exists: false }),
		).toThrow(ConfigValidationError);
	});

	test("resolves preview functions with deploy defaults and buckets with private access", () => {
		const config = defineConfig(() => ({
			preview: {
				functions: [
					{
						name: "Hello World",
						slug: "fn1",
						source: "./functions/hello-world.ts",
						env: { RESEND_API_KEY: "re_abc" },
					},
				],
				buckets: [{ name: "uploads" }],
				aiGateway: { enabled: true },
			},
		}));
		const resolved = resolveConfig(config, {
			name: "preview-1",
			exists: false,
		});
		expect(resolved.preview).toEqual({
			functions: [
				{
					slug: "fn1",
					name: "Hello World",
					source: "./functions/hello-world.ts",
					env: { RESEND_API_KEY: "re_abc" },
					runtime: "nodejs24",
					memoryMib: 512,
				},
			],
			buckets: [{ name: "uploads", access: "private" }],
			aiGatewayEnabled: true,
		});
	});

	test("treats aiGateway enabled:false as disabled", () => {
		const config = defineConfig(() => ({
			preview: { aiGateway: { enabled: false } },
		}));
		const resolved = resolveConfig(config, {
			name: "preview-1",
			exists: false,
		});
		expect(resolved.preview?.aiGatewayEnabled).toBe(false);
	});

	test("passes a function dev block through untouched", () => {
		const config = defineConfig(() => ({
			preview: {
				functions: [
					{
						name: "Hello",
						slug: "hello",
						source: "./hello.ts",
						dev: { port: 8787, portless: true },
					},
				],
			},
		}));
		const resolved = resolveConfig(config, {
			name: "preview-1",
			exists: false,
		});
		expect(resolved.preview?.functions[0].dev).toEqual({
			port: 8787,
			portless: true,
		});
	});

	test("omits dev from the resolved function when not provided", () => {
		const config = defineConfig(() => ({
			preview: {
				functions: [
					{ name: "Hello", slug: "hello", source: "./hello.ts" },
				],
			},
		}));
		const resolved = resolveConfig(config, {
			name: "preview-1",
			exists: false,
		});
		expect(resolved.preview?.functions[0]).not.toHaveProperty("dev");
	});

	test("rejects a function env value that is undefined (e.g. unset process.env)", () => {
		const config = defineConfig(() => ({
			preview: {
				functions: [
					{
						name: "Hello",
						slug: "hello",
						source: "./hello.ts",
						// Simulates `RESEND_API_KEY: process.env.RESEND_API_KEY` when unset.
						env: { RESEND_API_KEY: undefined as unknown as string },
					},
				],
			},
		}));
		expect(() =>
			resolveConfig(config, { name: "preview-1", exists: false }),
		).toThrow(ConfigValidationError);
	});

	test("rejects an invalid function slug", () => {
		const config = defineConfig(() => ({
			preview: {
				functions: [
					{ name: "Bad", slug: "Hello World", source: "./x.ts" },
				],
			},
		}));
		expect(() =>
			resolveConfig(config, { name: "preview-1", exists: false }),
		).toThrow(ConfigValidationError);
	});

	test("rejects a hyphenated function slug (only letters and digits allowed)", () => {
		const config = defineConfig(() => ({
			preview: {
				functions: [
					{ name: "H", slug: "hello-world", source: "./x.ts" },
				],
			},
		}));
		expect(() =>
			resolveConfig(config, { name: "preview-1", exists: false }),
		).toThrow(ConfigValidationError);
	});

	test("rejects a function slug longer than 20 chars", () => {
		const config = defineConfig(() => ({
			preview: {
				functions: [
					{ name: "L", slug: "a".repeat(21), source: "./x.ts" },
				],
			},
		}));
		expect(() =>
			resolveConfig(config, { name: "preview-1", exists: false }),
		).toThrow(ConfigValidationError);
	});

	test("accepts a valid alphanumeric function slug", () => {
		const config = defineConfig(() => ({
			preview: {
				functions: [{ name: "OK", slug: "fn1", source: "./x.ts" }],
			},
		}));
		expect(
			resolveConfig(config, { name: "preview-1", exists: false }).preview
				?.functions[0].slug,
		).toBe("fn1");
	});

	test("rejects duplicate function slugs", () => {
		const config = defineConfig(() => ({
			preview: {
				functions: [
					{ name: "A", slug: "dup", source: "./a.ts" },
					{ name: "B", slug: "dup", source: "./b.ts" },
				],
			},
		}));
		expect(() =>
			resolveConfig(config, { name: "preview-1", exists: false }),
		).toThrow(ConfigValidationError);
	});
});
