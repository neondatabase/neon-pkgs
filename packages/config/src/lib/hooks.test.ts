import { describe, expect, test } from "vitest";
import { defineConfig } from "./define-config.js";
import { ConfigValidationError } from "./errors.js";
import type { CheckoutBeforeContext, CheckoutBeforeResult } from "./types.js";

describe("defineConfig hooks", () => {
	test("accepts function-form checkout/create/deploy hooks and carries them through", () => {
		const config = defineConfig({
			auth: true,
			hooks: {
				checkout: {
					before: ({ inputName }) => ({
						name: `preview/${inputName}`,
					}),
					after: async () => {},
				},
				create: {
					before: () => {},
					after: async () => {},
				},
				deploy: {
					before: () => {},
					after: async () => {},
				},
			},
		});
		expect(typeof config.hooks?.checkout?.before).toBe("function");
		expect(typeof config.hooks?.create?.after).toBe("function");
		expect(typeof config.hooks?.deploy?.after).toBe("function");
	});

	test("accepts shell-command hooks (string and array)", () => {
		const config = defineConfig({
			hooks: {
				checkout: { after: "npm run db:migrate" },
				create: { after: "npm run db:seed" },
				deploy: { after: ["npm run build", "npm run db:migrate"] },
			},
		});
		expect(config.hooks?.checkout?.after).toBe("npm run db:migrate");
		expect(config.hooks?.create?.after).toBe("npm run db:seed");
		expect(config.hooks?.deploy?.after).toEqual([
			"npm run build",
			"npm run db:migrate",
		]);
	});

	test("rejects an unknown hook phase", () => {
		expect(() =>
			defineConfig({ hooks: { dev: { after: "x" } } as never }),
		).toThrow(ConfigValidationError);
	});

	test("rejects an unknown key inside a phase", () => {
		expect(() =>
			defineConfig({
				hooks: { checkout: { during: "x" } as never },
			}),
		).toThrow(ConfigValidationError);
	});

	test("rejects an empty shell-command string", () => {
		expect(() =>
			defineConfig({ hooks: { deploy: { after: "" } } }),
		).toThrow(ConfigValidationError);
	});

	test("rejects an empty shell-command array", () => {
		expect(() =>
			defineConfig({ hooks: { deploy: { after: [] } } }),
		).toThrow(ConfigValidationError);
	});

	test("rejects a non-empty array containing an empty command", () => {
		expect(() =>
			defineConfig({ hooks: { deploy: { after: ["ok", ""] } } }),
		).toThrow(ConfigValidationError);
	});

	test("rejects a hook value that is neither a function nor a shell command", () => {
		expect(() =>
			defineConfig({ hooks: { deploy: { after: 42 as never } } }),
		).toThrow(ConfigValidationError);
	});

	test("a policy with no hooks leaves config.hooks undefined", () => {
		const config = defineConfig({ auth: true });
		expect(config.hooks).toBeUndefined();
	});

	test("checkout.before can return a rename result", () => {
		const config = defineConfig({
			hooks: {
				checkout: {
					before: ({ inputName }: CheckoutBeforeContext) => {
						if (inputName === "main") return { name: "main" };
						return { name: `preview/${inputName}` };
					},
				},
			},
		});
		const before = config.hooks?.checkout?.before;
		// It's a function in this case; invoke it to confirm the rename contract.
		if (typeof before !== "function") throw new Error("expected function");
		const result = before({
			inputName: "dev-1",
			git: {
				available: false,
				isDetached: false,
				isDirty: false,
				triggeredByGitHook: false,
			},
		}) as CheckoutBeforeResult;
		expect(result).toEqual({ name: "preview/dev-1" });
	});

	test("create.before receives the branch name and git context, and can abort", () => {
		const config = defineConfig({
			hooks: {
				create: {
					before: ({ branchName }) => {
						if (branchName === "forbidden") {
							throw new Error("branch name not allowed");
						}
					},
				},
			},
		});
		const before = config.hooks?.create?.before;
		if (typeof before !== "function") throw new Error("expected function");
		const git = {
			available: false,
			isDetached: false,
			isDirty: false,
			triggeredByGitHook: false,
		};
		expect(() => before({ branchName: "forbidden", git })).toThrow(
			"branch name not allowed",
		);
		expect(before({ branchName: "dev-1", git })).toBeUndefined();
	});
});
