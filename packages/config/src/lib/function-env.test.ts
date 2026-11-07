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

const declared = (values: Record<string, string | undefined>) =>
	({
		TOKEN: { value: values.TOKEN, required: true },
		DSN: { value: values.DSN, required: "default-branch" },
		GUILD: { value: values.GUILD, required: false },
		KEPT: { value: values.KEPT, required: false, onUndefined: "skip" },
	}) satisfies Record<string, FunctionEnvVar>;

describe("resolveFunctionEnv", () => {
	test("uses every set value for every target", () => {
		const values = { TOKEN: "t", DSN: "d", GUILD: "g", KEPT: "k" };
		for (const target of [
			PRODUCTION,
			PREVIEW,
			"deploy",
			"development",
		] as const) {
			expect(resolveFunctionEnv(declared(values), target)).toEqual({
				env: values,
				missing: [],
			});
		}
	});

	test("the default branch: required: true and default-branch are missing", () => {
		expect(resolveFunctionEnv(declared({}), PRODUCTION)).toEqual({
			env: { GUILD: "" },
			missing: ["TOKEN", "DSN"],
		});
	});

	test('another branch: "default-branch" is removed like required: false', () => {
		expect(resolveFunctionEnv(declared({}), PREVIEW)).toEqual({
			env: { DSN: "", GUILD: "" },
			missing: ["TOKEN"],
		});
	});

	test('an unknown branch ("deploy"): "default-branch" counts as required', () => {
		expect(resolveFunctionEnv(declared({}), "deploy").missing).toEqual([
			"TOKEN",
			"DSN",
		]);
	});

	test("development: only required: true is missing, and nothing is removed", () => {
		expect(resolveFunctionEnv(declared({}), "development")).toEqual({
			env: {},
			missing: ["TOKEN"],
		});
	});

	test("an empty value counts as unset", () => {
		const empty = { TOKEN: "", DSN: "", GUILD: "", KEPT: "" };
		expect(resolveFunctionEnv(declared(empty), PRODUCTION)).toEqual(
			resolveFunctionEnv(declared({}), PRODUCTION),
		);
	});
});

describe("splitFunctionEnv", () => {
	test("keeps literal strings apart from declarations", () => {
		expect(
			splitFunctionEnv({
				LOG_LEVEL: "info",
				TOKEN: { value: "t", required: true },
			}),
		).toEqual({
			env: { LOG_LEVEL: "info" },
			envVars: { TOKEN: { value: "t", required: true } },
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
	test("accepts an unset value, so another function's missing secret cannot fail it", () => {
		expect(() =>
			defineConfig({
				functions: {
					alpha: {
						name: "Alpha",
						source: "./alpha.ts",
						env: { SECRET_A: { value: undefined, required: true } },
					},
				},
			}),
		).not.toThrow();
	});
});

describe("missingFunctionEnv / assertFunctionEnv", () => {
	const config = (values: Record<string, string | undefined>) =>
		defineConfig({
			functions: {
				alpha: {
					name: "Alpha",
					source: "./alpha.ts",
					env: {
						SECRET_A: { value: values.SECRET_A, required: true },
						LOG_LEVEL: "info",
					},
				},
				beta: {
					name: "Beta",
					source: "./beta.ts",
					env: {
						SECRET_B: {
							value: values.SECRET_B,
							required: "default-branch",
						},
					},
				},
			},
		});

	test("names every missing key per function", () => {
		expect(missingFunctionEnv(config({}), PRODUCTION)).toEqual([
			{ slug: "alpha", key: "SECRET_A" },
			{ slug: "beta", key: "SECRET_B" },
		]);
		expect(missingFunctionEnv(config({}), PREVIEW)).toEqual([
			{ slug: "alpha", key: "SECRET_A" },
		]);
		expect(missingFunctionEnv(config({}), "development")).toEqual([
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
						env: { SECRET_A: { value: undefined, required: true } },
					},
				},
			},
		});
		expect(missingFunctionEnv(preview, PRODUCTION)).toEqual([
			{ slug: "alpha", key: "SECRET_A" },
		]);
	});

	test("throws one ConfigValidationError listing each key", () => {
		let caught: unknown;
		try {
			assertFunctionEnv(config({ SECRET_B: "b" }), PRODUCTION);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ConfigValidationError);
		expect((caught as ConfigValidationError).issues).toEqual([
			'Environment variable "SECRET_A" for function "alpha" is required and unset. Set it in the environment or in the file passed to --env.',
		]);
		expect(() =>
			assertFunctionEnv(
				config({ SECRET_A: "a", SECRET_B: "b" }),
				PRODUCTION,
			),
		).not.toThrow();
	});

	test('neon dev points at required: "default-branch"', () => {
		expect(() => assertFunctionEnv(config({}), "development")).toThrow(
			'or declare it required: "default-branch" if only the default branch\'s deployment needs it.',
		);
	});
});
