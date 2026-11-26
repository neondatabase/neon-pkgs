import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	installedConfigVersion,
	planScaffold,
	supportsDeclaredEnv,
} from "./scaffold.js";

describe("planScaffold env", () => {
	it("carries each variable's required, defaulting to true", () => {
		const plan = planScaffold(
			{
				template: {
					id: "mailer",
					title: "Mailer",
					description: "Mailer",
					layout: "router",
					dependencies: [],
					environment: [
						{ name: "API_KEY", description: "Key" },
						{
							name: "REPLY_TO",
							description: "Reply-to",
							required: false,
						},
						{
							name: "SENTRY_DSN",
							description: "DSN",
							required: "default-branch",
						},
					],
				},
				sources: new Map([
					["functions/index.ts", "export default {};\n"],
				]),
			},
			[],
			"mailer",
		);
		expect(plan.functions[0]?.env).toEqual([
			{ name: "API_KEY", required: true },
			{ name: "REPLY_TO", required: false },
			{ name: "SENTRY_DSN", required: "default-branch" },
		]);
	});
});

describe("supportsDeclaredEnv", () => {
	it("needs @neon/config 1.13.0 or later, and assumes it when none is installed", () => {
		expect(supportsDeclaredEnv("1.12.9")).toBe(false);
		expect(supportsDeclaredEnv("0.9.1")).toBe(false);
		expect(supportsDeclaredEnv("1.13.0")).toBe(true);
		expect(supportsDeclaredEnv("2.0.0")).toBe(true);
		expect(supportsDeclaredEnv(undefined)).toBe(true);
	});
});

describe("installedConfigVersion", () => {
	let root: string;
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("reads the nearest node_modules/@neon/config", () => {
		root = mkdtempSync(join(tmpdir(), "neon-config-version-"));
		const pkg = join(root, "node_modules", "@neon", "config");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({ name: "@neon/config", version: "1.12.0" }),
		);
		const app = join(root, "apps", "api");
		mkdirSync(app, { recursive: true });
		expect(installedConfigVersion(app)).toBe("1.12.0");
	});
});
