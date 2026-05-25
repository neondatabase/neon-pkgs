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

	test("treats explicit feature false as disabled", () => {
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
});
