import {
	type CredentialSelection,
	displacedProfileWarning,
	selectCredential,
} from "@neon-internals/cli-core/auth_selection";
import { describe, expect, test } from "vitest";

describe("selectCredential", () => {
	test("an explicit --api-key is used as given", () => {
		expect(selectCredential({ apiKeyFlag: "flag-key" })).toEqual({
			source: "explicit-api-key",
			apiKey: "flag-key",
		});
	});

	test("an explicit --profile is used as given", () => {
		expect(selectCredential({ profileFlag: "work" })).toEqual({
			source: "profile",
			profile: "work",
			explicit: true,
		});
	});

	// Two flags express different intents, so there is no reading of the command that makes
	// both true. Guessing a winner is what the old behaviour did.
	test("both flags together is an error naming both", () => {
		expect(() =>
			selectCredential({ apiKeyFlag: "flag-key", profileFlag: "work" }),
		).toThrow(/--api-key or --profile, not both/);
	});

	// The bug this module exists for: an exported key silently voided an explicit --profile.
	test("an explicit --profile beats an ambient NEON_API_KEY", () => {
		expect(
			selectCredential({
				profileFlag: "work",
				apiKeyEnv: "ambient-key",
			}),
		).toEqual({ source: "profile", profile: "work", explicit: true });
	});

	test("an explicit --api-key beats an ambient NEON_PROFILE", () => {
		expect(
			selectCredential({ apiKeyFlag: "flag-key", profileEnv: "work" }),
		).toEqual({ source: "explicit-api-key", apiKey: "flag-key" });
	});

	// Both ambient: the key wins, so a pipeline injecting NEON_API_KEY is unaffected by a
	// NEON_PROFILE that leaked into the environment.
	test("between two ambient sources the key wins, and names what it displaced", () => {
		const selection = selectCredential({
			apiKeyEnv: "ambient-key",
			profileEnv: "work",
		});
		expect(selection).toEqual({
			source: "ambient-api-key",
			apiKey: "ambient-key",
			ignoredProfile: "work",
		});
		expect(displacedProfileWarning(selection)).toMatch(
			/profile "work" from NEON_PROFILE was ignored/,
		);
	});

	test("an ambient key alone displaces nothing and warns about nothing", () => {
		const selection = selectCredential({ apiKeyEnv: "ambient-key" });
		expect(selection).toEqual({
			source: "ambient-api-key",
			apiKey: "ambient-key",
		});
		expect(displacedProfileWarning(selection)).toBeNull();
	});

	test("NEON_PROFILE alone selects that profile, and counts as explicit", () => {
		expect(selectCredential({ profileEnv: "work" })).toEqual({
			source: "profile",
			profile: "work",
			explicit: true,
		});
	});

	test("nothing set selects DEFAULT", () => {
		expect(selectCredential({})).toEqual({
			source: "profile",
			profile: "DEFAULT",
			explicit: false,
		});
	});

	test("whitespace-only values are treated as unset throughout", () => {
		expect(
			selectCredential({
				apiKeyFlag: "   ",
				profileFlag: "  ",
				apiKeyEnv: " ",
				profileEnv: "\t",
			}),
		).toEqual({
			source: "profile",
			profile: "DEFAULT",
			explicit: false,
		});
	});

	// A key is trimmed before use, so a trailing newline from `--api-key "$(cat file)"` does
	// not travel into an Authorization header.
	test("a key from a flag is trimmed", () => {
		expect(selectCredential({ apiKeyFlag: "  padded-key\n" })).toEqual({
			source: "explicit-api-key",
			apiKey: "padded-key",
		});
	});

	test("a key from the environment is trimmed", () => {
		expect(selectCredential({ apiKeyEnv: "  padded-key\n" })).toEqual({
			source: "ambient-api-key",
			apiKey: "padded-key",
		});
	});

	// The selection is a function of its arguments and nothing else, which is what keeps
	// `ensureAuth` — called directly by tests — from depending on the developer's shell.
	test("it does not read process.env", () => {
		const previous = process.env.NEON_API_KEY;
		process.env.NEON_API_KEY = "should-be-ignored";
		try {
			expect(selectCredential({})).toEqual({
				source: "profile",
				profile: "DEFAULT",
				explicit: false,
			});
		} finally {
			if (previous === undefined) delete process.env.NEON_API_KEY;
			else process.env.NEON_API_KEY = previous;
		}
	});

	test("displacedProfileWarning is null for anything that is not a displaced profile", () => {
		const selections: CredentialSelection[] = [
			{ source: "profile", profile: "work", explicit: true },
			{ source: "explicit-api-key", apiKey: "k" },
			{ source: "ambient-api-key", apiKey: "k" },
		];
		for (const selection of selections) {
			expect(displacedProfileWarning(selection)).toBeNull();
		}
	});
});
