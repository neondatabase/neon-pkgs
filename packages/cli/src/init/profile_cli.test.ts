import {
	type CredentialInputs,
	recordCredentialInputs,
} from "@neon-internals/cli-core/auth_selection";
import { afterEach, describe, expect, test, vi } from "vitest";
import { enrichResponse } from "./enrich_output.js";
import { neonctlCmd } from "./neonctl.js";
import {
	explicitProfileArgs,
	neonInitAgentCmd,
	npxNeonArgs,
	selectedConfigDir,
	selectedProfileName,
} from "./profile_cli.js";

// `neonBin()` emits the installed `neon` binary when it's on PATH, else `npx -y neon`.
// Pin it to the not-installed branch so the emitted command strings are deterministic
// regardless of whether the test machine has `neon` globally installed.
vi.mock("which", () => ({
	default: { sync: () => null },
}));

const EMPTY: CredentialInputs = {
	apiKeyFlag: "",
	apiKeyEnv: "",
	profileEnv: "",
	profileFlag: "",
	configDir: "",
};

afterEach(() => {
	recordCredentialInputs(EMPTY);
});

describe("init profile CLI flags", () => {
	test("implicit DEFAULT emits no --profile", () => {
		recordCredentialInputs(EMPTY);

		expect(selectedProfileName()).toBe("DEFAULT");
		expect(explicitProfileArgs()).toEqual([]);
		expect(neonctlCmd()).toBe("CI= npx -y neon");
		expect(npxNeonArgs(["me"])).toEqual(["-y", "neon", "me"]);
		expect(neonInitAgentCmd({ step: "auth" })).toBe(
			`npx -y neon init --agent --data '{"step":"auth"}'`,
		);
	});

	test("--profile work is on every emitted neon command", () => {
		recordCredentialInputs({ ...EMPTY, profileFlag: "work" });

		expect(selectedProfileName()).toBe("work");
		expect(explicitProfileArgs()).toEqual(["--profile", "work"]);
		expect(neonctlCmd()).toBe("CI= npx -y neon --profile work");
		expect(npxNeonArgs(["me"])).toEqual([
			"-y",
			"neon",
			"--profile",
			"work",
			"me",
		]);
		expect(neonInitAgentCmd({ step: "setup" })).toBe(
			`npx -y neon init --agent --profile work --data '{"step":"setup"}'`,
		);
	});

	test("explicit --profile DEFAULT is kept, so an ambient NEON_PROFILE cannot override it", () => {
		recordCredentialInputs({ ...EMPTY, profileFlag: "DEFAULT" });

		expect(explicitProfileArgs()).toEqual(["--profile", "DEFAULT"]);
		expect(neonctlCmd()).toBe("CI= npx -y neon --profile DEFAULT");
		expect(neonInitAgentCmd({ step: "skills" })).toContain(
			"--profile DEFAULT",
		);
	});

	test("NEON_PROFILE=work is treated as explicit, same as the flag", () => {
		recordCredentialInputs({ ...EMPTY, profileEnv: "work" });

		expect(selectedProfileName()).toBe("work");
		expect(neonctlCmd()).toBe("CI= npx -y neon --profile work");
		expect(npxNeonArgs(["auth"])).toEqual([
			"-y",
			"neon",
			"--profile",
			"work",
			"auth",
		]);
	});

	test("enrichResponse puts --profile and --config-dir on the command, not inside --data", () => {
		recordCredentialInputs({
			...EMPTY,
			profileFlag: "work",
			configDir: "/tmp/flagged-cfg",
		});

		const enriched = enrichResponse({
			type: "run_neon_init",
			args: ["auth", "--json", "--verify", "--config-dir", "/ignored"],
		});

		expect(enriched).toEqual({
			type: "run_shell_command",
			command: `npx -y neon init --agent --profile work --config-dir '/tmp/flagged-cfg' --data '{"step":"auth","verify":true}'`,
		});
	});

	test("a recorded --config-dir wins over NEON_CONFIG_DIR", () => {
		recordCredentialInputs({ ...EMPTY, configDir: "/tmp/flagged-cfg" });
		expect(selectedConfigDir()).toBe("/tmp/flagged-cfg");
	});

	test("a recorded --config-dir is on npx neon and on printed commands", () => {
		recordCredentialInputs({
			...EMPTY,
			profileFlag: "work",
			configDir: "/tmp/flagged-cfg",
		});

		expect(npxNeonArgs(["orgs", "list"])).toEqual([
			"-y",
			"neon",
			"--profile",
			"work",
			"--config-dir",
			"/tmp/flagged-cfg",
			"orgs",
			"list",
		]);
		expect(neonctlCmd()).toBe(
			"CI= npx -y neon --profile work --config-dir '/tmp/flagged-cfg'",
		);
		expect(neonInitAgentCmd({ step: "skills" })).toBe(
			`npx -y neon init --agent --profile work --config-dir '/tmp/flagged-cfg' --data '{"step":"skills"}'`,
		);
	});

	test("a path with a single quote is still a valid shell token", () => {
		recordCredentialInputs({
			...EMPTY,
			configDir: "/tmp/cfg's",
		});
		expect(neonctlCmd()).toBe(
			"CI= npx -y neon --config-dir '/tmp/cfg'\\''s'",
		);
	});
});
