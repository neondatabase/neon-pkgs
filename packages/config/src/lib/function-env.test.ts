import { describe, expect, test } from "vitest";
import { defineConfig } from "./define-config.js";
import { ConfigValidationError } from "./errors.js";
import {
	assertFunctionEnv,
	missingFunctionEnv,
	resolveFunctionEnv,
	splitFunctionEnv,
} from "./function-env.js";
import type { FunctionEnvVar } from "./types.js";

const DECLARED = {
	TOKEN: { required: true },
	DSN: { required: "deploy" },
	GUILD: { required: false },
	ADMIN: { required: false, ifUnset: "keep" },
	RATE: { default: "1" },
} satisfies Record<string, FunctionEnvVar>;

describe("resolveFunctionEnv", () => {
	test("uses every set value for both targets", () => {
		const source = {
			TOKEN: "t",
			DSN: "d",
			GUILD: "g",
			ADMIN: "a",
			RATE: "0.5",
		};
		for (const target of ["deploy", "run"] as const) {
			expect(resolveFunctionEnv(DECLARED, source, target)).toEqual({
				env: source,
				missing: [],
			});
		}
	});

	test("deploy: required keys are missing, optional ones delete or keep, defaults apply", () => {
		expect(resolveFunctionEnv(DECLARED, {}, "deploy")).toEqual({
			env: { GUILD: "", RATE: "1" },
			missing: ["TOKEN", "DSN"],
		});
	});

	test("run: only required: true is missing, and nothing is deleted", () => {
		expect(resolveFunctionEnv(DECLARED, {}, "run")).toEqual({
			env: { RATE: "1" },
			missing: ["TOKEN"],
		});
	});

	test("an empty value counts as unset", () => {
		const empty = { TOKEN: "", DSN: "", GUILD: "", ADMIN: "", RATE: "" };
		expect(resolveFunctionEnv(DECLARED, empty, "deploy")).toEqual(
			resolveFunctionEnv(DECLARED, {}, "deploy"),
		);
	});
});

describe("splitFunctionEnv", () => {
	test("keeps literal strings apart from declarations", () => {
		expect(
			splitFunctionEnv({ LOG_LEVEL: "info", TOKEN: { required: true } }),
		).toEqual({
			env: { LOG_LEVEL: "info" },
			envVars: { TOKEN: { required: true } },
		});
	});

	test("omits envVars when nothing is declared", () => {
		expect(splitFunctionEnv({ LOG_LEVEL: "info" })).toEqual({
			env: { LOG_LEVEL: "info" },
		});
		expect(splitFunctionEnv(undefined)).toEqual({ env: {} });
	});
});

describe("defineConfig with declared env", () => {
	test("never reads process.env, so another function's unset secret cannot fail it", () => {
		delete process.env.NEON_PKGS_FUNCTION_ENV_TEST_A;
		expect(() =>
			defineConfig({
				functions: {
					alpha: {
						name: "Alpha",
						source: "./alpha.ts",
						env: {
							NEON_PKGS_FUNCTION_ENV_TEST_A: { required: true },
						},
					},
				},
			}),
		).not.toThrow();
	});
});

describe("missingFunctionEnv / assertFunctionEnv", () => {
	const config = defineConfig({
		functions: {
			alpha: {
				name: "Alpha",
				source: "./alpha.ts",
				env: { SECRET_A: { required: true }, LOG_LEVEL: "info" },
			},
			beta: {
				name: "Beta",
				source: "./beta.ts",
				env: { SECRET_B: { required: "deploy" } },
			},
		},
	});

	test("names every missing key per function", () => {
		expect(missingFunctionEnv(config, {}, "deploy")).toEqual([
			{ slug: "alpha", key: "SECRET_A" },
			{ slug: "beta", key: "SECRET_B" },
		]);
		expect(missingFunctionEnv(config, {}, "run")).toEqual([
			{ slug: "alpha", key: "SECRET_A" },
		]);
	});

	test("reads deprecated preview.functions too", () => {
		const preview = defineConfig({
			preview: {
				functions: {
					alpha: {
						name: "Alpha",
						source: "./alpha.ts",
						env: { SECRET_A: { required: true } },
					},
				},
			},
		});
		expect(missingFunctionEnv(preview, {}, "deploy")).toEqual([
			{ slug: "alpha", key: "SECRET_A" },
		]);
	});

	test("throws one ConfigValidationError listing each key", () => {
		let caught: unknown;
		try {
			assertFunctionEnv(config, { SECRET_B: "b" }, "deploy");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ConfigValidationError);
		expect((caught as ConfigValidationError).issues).toEqual([
			'Environment variable "SECRET_A" for function "alpha" is required and unset. Set it in the environment or in the file passed to --env.',
		]);
		expect(() =>
			assertFunctionEnv(
				config,
				{ SECRET_A: "a", SECRET_B: "b" },
				"deploy",
			),
		).not.toThrow();
	});
});
