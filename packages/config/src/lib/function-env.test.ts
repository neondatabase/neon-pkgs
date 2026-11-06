import { describe, expect, test } from "vitest";
import { defineConfig } from "./define-config.js";
import { ConfigValidationError } from "./errors.js";
import {
	assertFunctionEnv,
	missingFunctionEnv,
	resolveFunctionEnv,
	splitFunctionEnv,
} from "./function-env.js";
import type { BranchTarget, FunctionEnvVar } from "./types.js";

const PRODUCTION: BranchTarget = {
	name: "main",
	exists: true,
	isDefault: true,
};
const PREVIEW: BranchTarget = { name: "dev", exists: true, isDefault: false };

const DECLARED = {
	TOKEN: {},
	EXPLICIT: { required: true },
	DSN: { required: "default-branch" },
	GUILD: { required: false },
	RATE: { default: "1" },
} satisfies Record<string, FunctionEnvVar>;

describe("resolveFunctionEnv", () => {
	test("uses every set value for every target", () => {
		const source = {
			TOKEN: "t",
			EXPLICIT: "e",
			DSN: "d",
			GUILD: "g",
			RATE: "0.5",
		};
		for (const target of [
			PRODUCTION,
			PREVIEW,
			"deploy",
			"development",
		] as const) {
			expect(resolveFunctionEnv(DECLARED, source, target)).toEqual({
				env: source,
				missing: [],
			});
		}
	});

	test('the default branch: "default-branch" is missing like {}, and optionals are removed', () => {
		expect(resolveFunctionEnv(DECLARED, {}, PRODUCTION)).toEqual({
			env: { GUILD: "", RATE: "1" },
			missing: ["TOKEN", "EXPLICIT", "DSN"],
		});
	});

	test('another branch: "default-branch" is removed like an optional', () => {
		expect(resolveFunctionEnv(DECLARED, {}, PREVIEW)).toEqual({
			env: { DSN: "", GUILD: "", RATE: "1" },
			missing: ["TOKEN", "EXPLICIT"],
		});
	});

	test('deploy to an unknown branch: "default-branch" counts as required', () => {
		expect(resolveFunctionEnv(DECLARED, {}, "deploy").missing).toEqual([
			"TOKEN",
			"EXPLICIT",
			"DSN",
		]);
	});

	test("value is used instead of process.env.<key>, and an undefined value is unset", () => {
		const declared = {
			RENAMED: { value: "from-other" },
			UNSET: { value: undefined },
			FALLBACK: { value: undefined, default: "1" },
			OPTIONAL: { value: "", required: false },
		} satisfies Record<string, FunctionEnvVar>;
		const source = {
			RENAMED: "ignored",
			UNSET: "ignored",
			OPTIONAL: "ignored",
		};
		expect(resolveFunctionEnv(declared, source, PRODUCTION)).toEqual({
			env: { RENAMED: "from-other", FALLBACK: "1", OPTIONAL: "" },
			missing: ["UNSET"],
		});
	});

	test("an empty value counts as unset", () => {
		const empty = { TOKEN: "", EXPLICIT: "", DSN: "", GUILD: "", RATE: "" };
		expect(resolveFunctionEnv(DECLARED, empty, PRODUCTION)).toEqual(
			resolveFunctionEnv(DECLARED, {}, PRODUCTION),
		);
	});
});

describe("splitFunctionEnv", () => {
	test("keeps literal strings apart from declarations", () => {
		expect(splitFunctionEnv({ LOG_LEVEL: "info", TOKEN: {} })).toEqual({
			env: { LOG_LEVEL: "info" },
			envVars: { TOKEN: {} },
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
						env: { NEON_PKGS_FUNCTION_ENV_TEST_A: {} },
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
				env: { SECRET_A: {}, LOG_LEVEL: "info" },
			},
			beta: {
				name: "Beta",
				source: "./beta.ts",
				env: { SECRET_B: { required: "default-branch" } },
			},
		},
	});

	test("names every missing key per function", () => {
		expect(missingFunctionEnv(config, {}, PRODUCTION)).toEqual([
			{ slug: "alpha", key: "SECRET_A" },
			{ slug: "beta", key: "SECRET_B" },
		]);
		expect(missingFunctionEnv(config, {}, PREVIEW)).toEqual([
			{ slug: "alpha", key: "SECRET_A" },
		]);
		expect(missingFunctionEnv(config, {}, "development")).toEqual([
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
						env: { SECRET_A: {} },
					},
				},
			},
		});
		expect(missingFunctionEnv(preview, {}, PRODUCTION)).toEqual([
			{ slug: "alpha", key: "SECRET_A" },
		]);
	});

	test("throws one ConfigValidationError listing each key", () => {
		let caught: unknown;
		try {
			assertFunctionEnv(config, { SECRET_B: "b" }, PRODUCTION);
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
				PRODUCTION,
			),
		).not.toThrow();
	});

	test('neon dev points at { required: "default-branch" }', () => {
		expect(() => assertFunctionEnv(config, {}, "development")).toThrow(
			'or declare it { required: "default-branch" } if only the default branch\'s deployment needs it.',
		);
	});
});
