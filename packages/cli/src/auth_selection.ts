/**
 * # Which credential an invocation authenticates with
 *
 * Four inputs can each answer "who am I": the `--api-key` flag, `NEON_API_KEY`, the
 * `--profile` flag, and `NEON_PROFILE`. This module decides between them, and it is pure so
 * the decision can be tested without a filesystem, a network, or a config directory.
 *
 * ## The rule
 *
 * **An explicit flag beats an ambient environment variable.** That single rule fixes the bug
 * this module exists for: before it, any API key — including one merely exported into the
 * shell — silently voided `--profile`, so `neon --profile work …` would quietly run as
 * whoever `NEON_API_KEY` belonged to and say nothing about it.
 *
 * | Given | What runs |
 * | --- | --- |
 * | `--api-key` and `--profile` | neither: contradictory explicit flags, so this throws |
 * | `--api-key` and `NEON_PROFILE` | the flag's key |
 * | `--profile` and `NEON_API_KEY` | the profile |
 * | `NEON_API_KEY` and `NEON_PROFILE` | the key, and the ignored profile is named in a warning |
 * | `--profile` or `NEON_PROFILE` alone | that profile |
 * | nothing | `DEFAULT` |
 *
 * Two explicit flags throw rather than picking a winner. They express different intents —
 * `--api-key` supplies a credential, `--profile` selects a stored one — so there is no
 * reading of the command that makes both true, and guessing is how the original bug behaved.
 *
 * When both are merely ambient, the key wins. That keeps CI exactly as it was: a pipeline
 * that injects `NEON_API_KEY` must not change behaviour because a `NEON_PROFILE` leaked into
 * the environment. It warns instead of staying silent, because a disregarded account
 * selection is precisely what nobody noticed last time.
 *
 * `auth` and the `profile` subcommands do not use any of this. They read the same flags with
 * different meanings — `neon auth --profile work` names where to *write* a credential, and
 * `neon profile set-key work --api-key …` names one to *store* — so their callers skip
 * selection entirely rather than passing exemptions down here.
 */

import { DEFAULT_PROFILE } from "./profiles.js";

export type CredentialSelection =
	/** `--api-key`. Used as given; no profile is consulted and no stored file is touched. */
	| { source: "explicit-api-key"; apiKey: string }
	/** `NEON_API_KEY`, with the profile it displaced when there was one. */
	| { source: "ambient-api-key"; apiKey: string; ignoredProfile?: string }
	/** A profile, whose file decides whether that means an API key or OAuth. */
	| { source: "profile"; profile: string; explicit: boolean };

export type SelectionInput = {
	/** The `--api-key` flag, before any environment fallback has been folded into it. */
	apiKeyFlag?: string;
	/** The `--profile` flag. */
	profileFlag?: string;
	/** `NEON_API_KEY`. */
	apiKeyEnv?: string;
	/** `NEON_PROFILE`. */
	profileEnv?: string;
};

/**
 * What the four credential inputs were for this invocation, captured by
 * `resolveApiKeyFromEnv` — which is the one place that reads the environment.
 *
 * Two reasons this is module state rather than fields on the parsed arguments, the same two
 * that put `auth_context` here: an extra key on `args` is rejected by every command calling
 * `.strict()`, and a hidden option to carry it would be a second undocumented way to pass a
 * credential. One process is one invocation, so there is nothing to get out of step.
 *
 * Capturing the environment here rather than reading it inside {@link selectCredential} keeps
 * the selection a function of its arguments. That is not tidiness: `ensureAuth` is called
 * directly by tests, and reading `process.env` down in the decision made those tests depend on
 * whether the developer running them happened to have `NEON_API_KEY` exported.
 */
export type CredentialInputs = {
	apiKeyFlag: string;
	apiKeyEnv: string;
	profileEnv: string;
};

const NO_INPUTS: CredentialInputs = {
	apiKeyFlag: "",
	apiKeyEnv: "",
	profileEnv: "",
};

let inputs: CredentialInputs = NO_INPUTS;

export const recordCredentialInputs = (recorded: CredentialInputs): void => {
	inputs = recorded;
};

export const credentialInputs = (): CredentialInputs => inputs;

/** Reset between tests, so one case cannot observe another's inputs. */
export const clearCredentialInputs = (): void => {
	inputs = NO_INPUTS;
};

export const selectCredential = ({
	apiKeyFlag,
	profileFlag,
	apiKeyEnv,
	profileEnv,
}: SelectionInput): CredentialSelection => {
	const flagKey = nonEmpty(apiKeyFlag);
	const flagProfile = nonEmpty(profileFlag);

	if (flagKey !== undefined && flagProfile !== undefined) {
		throw new Error(
			"Pass either --api-key or --profile, not both. --api-key supplies a credential directly; --profile selects a stored one.",
		);
	}

	if (flagKey !== undefined) {
		return { source: "explicit-api-key", apiKey: flagKey };
	}

	if (flagProfile !== undefined) {
		return { source: "profile", profile: flagProfile, explicit: true };
	}

	const envKey = nonEmpty(apiKeyEnv);
	const envProfile = nonEmpty(profileEnv);

	if (envKey !== undefined) {
		return {
			source: "ambient-api-key",
			apiKey: envKey,
			...(envProfile !== undefined ? { ignoredProfile: envProfile } : {}),
		};
	}

	return {
		source: "profile",
		profile: envProfile ?? DEFAULT_PROFILE,
		explicit: envProfile !== undefined,
	};
};

/** The warning for an ambient key that displaced an ambient profile, or `null`. */
export const displacedProfileWarning = (
	selection: CredentialSelection,
): string | null =>
	selection.source === "ambient-api-key" &&
	selection.ignoredProfile !== undefined
		? `NEON_API_KEY is set, so profile "${selection.ignoredProfile}" from NEON_PROFILE was ignored. Pass --profile ${selection.ignoredProfile} to use it instead.`
		: null;

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
