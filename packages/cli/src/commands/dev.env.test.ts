import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { devEnvContext } from "./dev.js";

/**
 * What `neon dev` hands the resolver. Two properties matter and neither is visible from the
 * resolver's own tests: that dev asks for the AI Gateway (so local matches the deployed
 * runtime), and that it reads the local dotenv file (so the branch credential is reused
 * instead of re-minted on every start).
 */
describe("neon dev's resolver context", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neonctl-dev-ctx-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const props = { apiKey: "k", apiHost: "https://api", projectId: "p" };

	it("asks for the AI Gateway, which nothing can detect", () => {
		expect(devEnvContext(props, "br-1", cwd).implyAiGateway).toBe(true);
	});

	it("layers the dotenv file over process.env, so one-time secrets survive a restart", () => {
		writeFileSync(
			join(cwd, ".env.local"),
			"NEON_AI_GATEWAY_TOKEN=nt_live_credfake0001_secret\n",
		);

		const { env } = devEnvContext(props, "br-1", cwd);

		expect(env.NEON_AI_GATEWAY_TOKEN).toBe("nt_live_credfake0001_secret");
		expect(env.PATH).toBe(process.env.PATH);
	});

	it("reads the same file `env pull` writes, preferring an existing .env", () => {
		writeFileSync(join(cwd, ".env"), "AWS_ACCESS_KEY_ID=cred-from-env\n");
		writeFileSync(
			join(cwd, ".env.local"),
			"AWS_ACCESS_KEY_ID=cred-from-env-local\n",
		);

		expect(devEnvContext(props, "br-1", cwd).env.AWS_ACCESS_KEY_ID).toBe(
			"cred-from-env",
		);
	});

	it("works in a directory with no dotenv file at all", () => {
		const { env } = devEnvContext(props, "br-1", cwd);
		expect(env.NEON_AI_GATEWAY_TOKEN).toBeUndefined();
	});

	it("omits the branch rather than passing undefined when none is resolved", () => {
		expect(devEnvContext(props, undefined, cwd)).not.toHaveProperty(
			"branchId",
		);
	});
});
