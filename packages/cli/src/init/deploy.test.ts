import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missingDeployEnv } from "./deploy.js";

describe("missingDeployEnv", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neon-init-deploy-"));
		for (const key of ["LEGACY", "TOKEN", "DSN", "OPTIONAL"]) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("names unset legacy reads and declared variables a deploy requires", async () => {
		writeFileSync(
			join(cwd, "neon.ts"),
			`export default {
  functions: {
    bot: {
      name: "Bot",
      source: "./bot.ts",
      env: {
        LEGACY: process.env.LEGACY,
        TOKEN: {},
        DSN: { required: "production" },
        OPTIONAL: { required: false },
      },
    },
  },
};
`,
		);
		const envFile = join(cwd, ".env.local");
		writeFileSync(envFile, "TOKEN=from-file\n");
		await expect(
			missingDeployEnv({
				cwd,
				contextFile: join(cwd, ".neon"),
				envFile,
			}),
		).resolves.toEqual(["LEGACY", "DSN"]);
		expect(process.env.TOKEN).toBeUndefined();
	});
});
