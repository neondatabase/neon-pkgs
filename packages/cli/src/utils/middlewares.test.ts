import { credentialInputs } from "@neon-internals/cli-core/auth_selection";
import { afterEach, describe, expect, test, vi } from "vitest";
import yargs from "yargs/yargs";
import { fillInArgs, resolveApiKeyFromEnv } from "./middlewares.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("fillInArgs", () => {
	test("leaves array-valued options intact under strict validation", async () => {
		const parsed = await yargs(["-e", "DATABASE_URL", "-s", "postgres"])
			.exitProcess(false)
			.option("env", {
				alias: "e",
				type: "array",
				string: true,
			})
			.option("service", {
				alias: ["s", "services"],
				type: "array",
				string: true,
			})
			.middleware((args) => {
				fillInArgs(args);
			}, true)
			.strict()
			.parse();

		expect(parsed.env).toEqual(["DATABASE_URL"]);
		expect(parsed.service).toEqual(["postgres"]);
	});
});

/**
 * The capture, not the decision.
 *
 * `selectCredential` is well covered in `auth_selection.test.ts`, but every one of those cases
 * is fed by this middleware — it is the only place that reads the credential environment. A
 * wrong capture here would leave all of them green while the CLI silently authenticated as the
 * wrong account, which is the bug the precedence work exists to stop.
 */
describe("resolveApiKeyFromEnv", () => {
	test("records the flag separately from the environment", () => {
		vi.stubEnv("NEON_API_KEY", "napi_ambient");
		vi.stubEnv("NEON_PROFILE", "work");
		const args: Record<string, unknown> = { apiKey: "napi_flag" };

		resolveApiKeyFromEnv(args);

		// Both are captured. Losing the distinction is what let an exported key void `--profile`.
		expect(credentialInputs()).toEqual({
			apiKeyFlag: "napi_flag",
			apiKeyEnv: "napi_ambient",
			profileEnv: "work",
			profileFlag: "",
			configDir: "",
		});
	});

	test("leaves an explicit flag alone rather than folding the environment over it", () => {
		vi.stubEnv("NEON_API_KEY", "napi_ambient");
		const args: Record<string, unknown> = { apiKey: "napi_flag" };

		resolveApiKeyFromEnv(args);

		expect(args.apiKey).toBe("napi_flag");
	});

	// The fold is what lets every command that reads `props.apiKey` keep working unchanged.
	test("folds the environment into both spellings when no flag was passed", () => {
		vi.stubEnv("NEON_API_KEY", "napi_ambient");
		const args: Record<string, unknown> = { apiKey: "" };

		resolveApiKeyFromEnv(args);

		expect(args.apiKey).toBe("napi_ambient");
		expect(args["api-key"]).toBe("napi_ambient");
		// …and the flag is still recorded as absent, so `--profile` can outrank it.
		expect(credentialInputs().apiKeyFlag).toBe("");
	});

	test("an unset environment leaves an empty string rather than undefined", () => {
		vi.stubEnv("NEON_API_KEY", undefined);
		vi.stubEnv("NEON_PROFILE", undefined);
		const args: Record<string, unknown> = { apiKey: "" };

		resolveApiKeyFromEnv(args);

		expect(args.apiKey).toBe("");
		expect(credentialInputs()).toEqual({
			apiKeyFlag: "",
			apiKeyEnv: "",
			profileEnv: "",
			profileFlag: "",
			configDir: "",
		});
	});

	// yargs gives `undefined` rather than `""` when an option has no default, and treating that
	// as a flag value would make every invocation look like it passed `--api-key`.
	test("a missing apiKey property is treated as no flag", () => {
		vi.stubEnv("NEON_API_KEY", "napi_ambient");
		const args: Record<string, unknown> = {};

		resolveApiKeyFromEnv(args);

		expect(credentialInputs().apiKeyFlag).toBe("");
		expect(args.apiKey).toBe("napi_ambient");
	});

	// Whitespace is trimmed by `selectCredential`, not here — this records verbatim so the
	// decision layer stays the single place that defines "unset".
	test("records values verbatim, without trimming", () => {
		vi.stubEnv("NEON_API_KEY", "  napi_padded\n");
		const args: Record<string, unknown> = { apiKey: "  " };

		resolveApiKeyFromEnv(args);

		expect(credentialInputs().apiKeyFlag).toBe("  ");
		expect(credentialInputs().apiKeyEnv).toBe("  napi_padded\n");
	});

	// The snapshot is read by `ensureAuth` on every invocation, so a stale one from a previous
	// call would decide the next command's account.
	test("each call replaces the previous snapshot", () => {
		vi.stubEnv("NEON_API_KEY", "napi_first");
		resolveApiKeyFromEnv({ apiKey: "napi_flag" });
		expect(credentialInputs().apiKeyFlag).toBe("napi_flag");

		vi.stubEnv("NEON_API_KEY", "napi_second");
		resolveApiKeyFromEnv({ apiKey: "" });
		expect(credentialInputs()).toEqual({
			apiKeyFlag: "",
			apiKeyEnv: "napi_second",
			profileEnv: "",
			profileFlag: "",
			configDir: "",
		});
	});

	test("records --profile separately from NEON_PROFILE", () => {
		vi.stubEnv("NEON_PROFILE", "env");
		resolveApiKeyFromEnv({ apiKey: "", profile: "flag" });

		expect(credentialInputs().profileFlag).toBe("flag");
		expect(credentialInputs().profileEnv).toBe("env");
	});

	test("records --config-dir only when the flag is on argv", () => {
		const argv = process.argv;
		process.argv = [...argv, "--config-dir", "/tmp/neon-cfg"];
		try {
			resolveApiKeyFromEnv({ apiKey: "", configDir: "/tmp/neon-cfg" });
			expect(credentialInputs().configDir).toBe("/tmp/neon-cfg");
		} finally {
			process.argv = argv;
		}
	});

	test("records --config-dir=value the same way", () => {
		const argv = process.argv;
		process.argv = [...argv, "--config-dir=/tmp/equals-cfg"];
		try {
			resolveApiKeyFromEnv({
				apiKey: "",
				configDir: "/tmp/equals-cfg",
			});
			expect(credentialInputs().configDir).toBe("/tmp/equals-cfg");
		} finally {
			process.argv = argv;
		}
	});

	test("a yargs default for --config-dir is not recorded as a flag", () => {
		resolveApiKeyFromEnv({ apiKey: "", configDir: "/tmp/neon-cfg" });

		expect(credentialInputs().configDir).toBe("");
	});
});
