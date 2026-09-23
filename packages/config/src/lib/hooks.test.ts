import { describe, expect, test } from "vitest";
import { defineConfig } from "./define-config.js";
import { ConfigValidationError } from "./errors.js";
import type { CheckoutBeforeContext, CheckoutBeforeResult } from "./types.js";

describe("defineConfig experimental.hooks", () => {
	test("accepts function-form checkout/create/deploy hooks and carries them through", () => {
		const config = defineConfig({
			auth: true,
			experimental: {
				hooks: {
					checkout: {
						before: ({ event }) => ({
							name: `preview/${event.inputName}`,
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
			},
		});
		expect(typeof config.experimental?.hooks?.checkout?.before).toBe(
			"function",
		);
		expect(typeof config.experimental?.hooks?.create?.after).toBe(
			"function",
		);
		expect(typeof config.experimental?.hooks?.deploy?.after).toBe(
			"function",
		);
	});

	test("accepts shell-command hooks (string and array)", () => {
		const config = defineConfig({
			experimental: {
				hooks: {
					checkout: { after: "npm run db:migrate" },
					create: { after: "npm run db:seed" },
					deploy: { after: ["npm run build", "npm run db:migrate"] },
				},
			},
		});
		expect(config.experimental?.hooks?.checkout?.after).toBe(
			"npm run db:migrate",
		);
		expect(config.experimental?.hooks?.create?.after).toBe(
			"npm run db:seed",
		);
		expect(config.experimental?.hooks?.deploy?.after).toEqual([
			"npm run build",
			"npm run db:migrate",
		]);
	});

	test("rejects an unknown hook phase", () => {
		expect(() =>
			defineConfig({
				experimental: { hooks: { dev: { after: "x" } } as never },
			}),
		).toThrow(ConfigValidationError);
	});

	test("rejects an unknown key inside a phase", () => {
		expect(() =>
			defineConfig({
				experimental: {
					hooks: { checkout: { during: "x" } as never },
				},
			}),
		).toThrow(ConfigValidationError);
	});

	test("rejects an unknown key inside experimental", () => {
		expect(() =>
			defineConfig({ experimental: { dev: "x" } as never }),
		).toThrow(ConfigValidationError);
	});

	test("rejects an empty shell-command string", () => {
		expect(() =>
			defineConfig({
				experimental: { hooks: { deploy: { after: "" } } },
			}),
		).toThrow(ConfigValidationError);
	});

	test("rejects an empty shell-command array", () => {
		expect(() =>
			defineConfig({
				experimental: { hooks: { deploy: { after: [] } } },
			}),
		).toThrow(ConfigValidationError);
	});

	test("rejects a non-empty array containing an empty command", () => {
		expect(() =>
			defineConfig({
				experimental: { hooks: { deploy: { after: ["ok", ""] } } },
			}),
		).toThrow(ConfigValidationError);
	});

	test("rejects a hook value that is neither a function nor a shell command", () => {
		expect(() =>
			defineConfig({
				experimental: { hooks: { deploy: { after: 42 as never } } },
			}),
		).toThrow(ConfigValidationError);
	});

	test("a policy with no experimental block leaves config.experimental undefined", () => {
		const config = defineConfig({ auth: true });
		expect(config.experimental).toBeUndefined();
	});

	test("checkout.before can return a rename result, for a neon-checkout event", () => {
		const config = defineConfig({
			experimental: {
				hooks: {
					checkout: {
						before: ({ event }: CheckoutBeforeContext) => {
							if (event.inputName === "main")
								return { name: "main" };
							return { name: `preview/${event.inputName}` };
						},
					},
				},
			},
		});
		const before = config.experimental?.hooks?.checkout?.before;
		// It's a function in this case; invoke it to confirm the rename contract.
		if (typeof before !== "function") throw new Error("expected function");
		const result = before({
			event: { type: "neon-checkout", inputName: "dev-1" },
			git: {
				available: false,
				isDetached: false,
				isDirty: false,
			},
		}) as CheckoutBeforeResult;
		expect(result).toEqual({ name: "preview/dev-1" });
	});

	test("checkout.before's event.inputName is undefined for a git-checkout event", () => {
		const config = defineConfig({
			experimental: {
				hooks: {
					checkout: {
						before: (ctx) => {
							expect(ctx.event.inputName).toBeUndefined();
							if (ctx.event.type === "git-checkout") {
								return {
									name: `preview/${ctx.event.gitBranch}`,
								};
							}
						},
					},
				},
			},
		});
		const before = config.experimental?.hooks?.checkout?.before;
		if (typeof before !== "function") throw new Error("expected function");
		const result = before({
			event: { type: "git-checkout", gitBranch: "feature/billing" },
			git: { available: true, isDetached: false, isDirty: false },
		}) as CheckoutBeforeResult;
		expect(result).toEqual({ name: "preview/feature/billing" });
	});

	test("create.before receives the branch name, git context, and triggering event; can abort", () => {
		const config = defineConfig({
			experimental: {
				hooks: {
					create: {
						before: ({ branchName }) => {
							if (branchName === "forbidden") {
								throw new Error("branch name not allowed");
							}
						},
					},
				},
			},
		});
		const before = config.experimental?.hooks?.create?.before;
		if (typeof before !== "function") throw new Error("expected function");
		const git = {
			available: false,
			isDetached: false,
			isDirty: false,
		};
		const event = { type: "neon-checkout" as const };
		expect(() => before({ branchName: "forbidden", git, event })).toThrow(
			"branch name not allowed",
		);
		expect(before({ branchName: "dev-1", git, event })).toBeUndefined();
	});
});
