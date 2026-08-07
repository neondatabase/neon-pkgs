import { describe, expect, test } from "vitest";
import {
	branchTuningSchema,
	computeSettingsSchema,
	configInputSchema,
	dataApiConfigSchema,
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

	test("accepts externalPackages with bare, scoped, and subpath specifiers", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: "./hello.ts",
						externalPackages: [
							"microsandbox",
							"@scope/pkg",
							"pkg/sub",
						],
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("accepts an empty externalPackages list", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: "./hello.ts",
						externalPackages: [],
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects a relative path in externalPackages", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: "./hello.ts",
						externalPackages: ["./local-module.js"],
					},
				},
			},
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(formatZodIssues(result.error).join("\n")).toMatch(
				/not a relative or absolute path/,
			);
		}
	});

	test("rejects an absolute path in externalPackages", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: "./hello.ts",
						externalPackages: ["/opt/thing.js"],
					},
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("rejects a non-string entry in externalPackages", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: "./hello.ts",
						externalPackages: [42],
					},
				},
			},
		});
		expect(result.success).toBe(false);
	});

	const withExternalPackages = (externalPackages: unknown) =>
		configInputSchema.safeParse({
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: "./hello.ts",
						externalPackages,
					},
				},
			},
		});

	test("accepts the object form with includeFiles false", () => {
		const result = withExternalPackages([
			"sharp",
			{ name: "canvas", includeFiles: false },
		]);
		expect(result.success).toBe(true);
	});

	test("accepts an explicit includeFiles: true", () => {
		expect(
			withExternalPackages([{ name: "sharp", includeFiles: true }])
				.success,
		).toBe(true);
	});

	test("accepts the object form without includeFiles", () => {
		expect(withExternalPackages([{ name: "sharp" }]).success).toBe(true);
	});

	test("rejects an unknown key in the object form", () => {
		expect(
			withExternalPackages([{ name: "sharp", includeFile: false }])
				.success,
		).toBe(false);
	});

	test("rejects a non-boolean includeFiles", () => {
		expect(
			withExternalPackages([{ name: "sharp", includeFiles: "yes" }])
				.success,
		).toBe(false);
	});

	test("rejects an object entry with no name", () => {
		expect(withExternalPackages([{ includeFiles: false }]).success).toBe(
			false,
		);
	});

	test("rejects a relative path in the object form too", () => {
		const result = withExternalPackages([{ name: "./local-addon.node" }]);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(formatZodIssues(result.error).join("\n")).toMatch(
				/not a relative or absolute path/,
			);
		}
	});

	// A subpath is legal: it narrows what esbuild leaves unresolved. Files are staged per
	// package, so the subpath's package is what ships.
	test("accepts a subpath entry", () => {
		expect(withExternalPackages(["pkg/sub"]).success).toBe(true);
	});

	test("rejects the same package listed twice", () => {
		const result = withExternalPackages(["sharp", "sharp"]);
		expect(result.success).toBe(false);
		if (!result.success) {
			const issues = formatZodIssues(result.error).join("\n");
			expect(issues).toMatch(/listed more than once/);
			// Reported against the offending entry, not the whole function.
			expect(issues).toMatch(/externalPackages\[1\]/);
		}
	});

	test("rejects a bare name and a subpath of it that disagree about includeFiles", () => {
		const result = withExternalPackages([
			"sharp",
			{ name: "sharp/lib/index.js", includeFiles: false },
		]);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(formatZodIssues(result.error).join("\n")).toMatch(
				/disagree about includeFiles/,
			);
		}
	});

	test("accepts a bare name and a subpath of it that agree", () => {
		expect(
			withExternalPackages(["sharp", "sharp/lib/index.js"]).success,
		).toBe(true);
	});

	test("accepts two scoped packages sharing a scope", () => {
		// Same scope, different packages — not the same root, so not a conflict.
		expect(
			withExternalPackages([
				{ name: "@img/sharp-linux-arm64", includeFiles: false },
				"@img/colour",
			]).success,
		).toBe(true);
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

	test("explains an undefined function env value (e.g. unset process.env) by function + key", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					hello: {
						name: "Hello",
						source: "./hello.ts",
						// Simulates `test: process.env.TEST` when TEST is unset.
						env: { test: undefined },
					},
				},
			},
		});
		if (result.success) throw new Error("expected failure");
		const formatted = formatZodIssues(result.error).join("\n");
		// Points at the exact offending path…
		expect(formatted).toContain("preview.functions.hello.env.test");
		// …names the function and env key explicitly…
		expect(formatted).toContain('Environment variable "test"');
		expect(formatted).toContain('function "hello"');
		// …explains the likely cause and the fix…
		expect(formatted).toContain("process.env");
		// …and drops zod's opaque default.
		expect(formatted).not.toContain(
			"Invalid input: expected string, received undefined",
		);
	});

	test("keeps zod's default message for a non-undefined wrong-typed env value", () => {
		const result = configInputSchema.safeParse({
			preview: {
				functions: {
					hello: {
						name: "Hello",
						source: "./hello.ts",
						env: { count: 42 },
					},
				},
			},
		});
		if (result.success) throw new Error("expected failure");
		const formatted = formatZodIssues(result.error).join("\n");
		expect(formatted).toContain("preview.functions.hello.env.count");
		expect(formatted).toContain("expected string");
		// The undefined-specific guidance must not fire for a defined wrong type.
		expect(formatted).not.toContain("process.env");
	});
});

describe("dataApiConfigSchema", () => {
	test("accepts an empty object (defaults to neon auth)", () => {
		expect(dataApiConfigSchema.safeParse({}).success).toBe(true);
	});

	test("accepts neon auth with settings", () => {
		const result = dataApiConfigSchema.safeParse({
			authProvider: "neon",
			settings: { dbMaxRows: 1000, dbSchemas: ["public", "api"] },
		});
		expect(result.success).toBe(true);
	});

	test("accepts external auth with jwksUrl / providerName / jwtAudience", () => {
		const result = dataApiConfigSchema.safeParse({
			authProvider: "external",
			jwksUrl: "https://idp.example.com/.well-known/jwks.json",
			providerName: "Clerk",
			jwtAudience: "my-api",
		});
		expect(result.success).toBe(true);
	});

	test("rejects external-only fields when authProvider is neon (default)", () => {
		const result = dataApiConfigSchema.safeParse({
			jwksUrl: "https://idp.example.com/jwks.json",
		});
		if (result.success) throw new Error("expected failure");
		const formatted = formatZodIssues(result.error).join("\n");
		expect(formatted).toContain("jwksUrl");
		expect(formatted).toContain('authProvider: "external"');
	});

	test("rejects external-only fields with an explicit neon provider", () => {
		const result = dataApiConfigSchema.safeParse({
			authProvider: "neon",
			providerName: "Clerk",
		});
		expect(result.success).toBe(false);
	});

	test("rejects an unknown settings key (camelCase only)", () => {
		const result = dataApiConfigSchema.safeParse({
			settings: { db_max_rows: 1000 },
		});
		expect(result.success).toBe(false);
	});
});

describe("configInputSchema — Data API requires Neon Auth", () => {
	test("rejects a neon Data API without auth enabled", () => {
		const result = configInputSchema.safeParse({ dataApi: true });
		if (result.success) throw new Error("expected failure");
		const formatted = formatZodIssues(result.error).join("\n");
		expect(formatted).toContain("auth");
		expect(formatted).toContain('authProvider "neon"');
	});

	test("rejects a neon Data API when auth is explicitly disabled", () => {
		const result = configInputSchema.safeParse({
			auth: false,
			dataApi: { enabled: true },
		});
		expect(result.success).toBe(false);
	});

	test("accepts a neon Data API when auth is enabled", () => {
		const result = configInputSchema.safeParse({
			auth: true,
			dataApi: { settings: { dbMaxRows: 500 } },
		});
		expect(result.success).toBe(true);
	});

	test("accepts an external Data API without auth", () => {
		const result = configInputSchema.safeParse({
			dataApi: {
				authProvider: "external",
				jwksUrl: "https://idp.example.com/jwks.json",
			},
		});
		expect(result.success).toBe(true);
	});

	test("accepts a disabled Data API without auth", () => {
		const result = configInputSchema.safeParse({
			dataApi: { enabled: false },
		});
		expect(result.success).toBe(true);
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
