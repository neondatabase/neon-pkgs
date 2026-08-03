/**
 * Helpers for the API-key half of a profile: naming a minted key, reading one off disk, and
 * turning what the API says about a key into something displayable.
 *
 * Kept apart from `./commands/profile.ts` because these are the decisions worth testing
 * directly — the command around them is prompts, an API client, and output.
 */

import { randomBytes } from "node:crypto";
import type { AuthDetailsResponse } from "@neon/sdk/raw";

/** Auth methods that are an API key. Anything else is not a key and must not be stored as one. */
const API_KEY_METHODS = ["api_key_user", "api_key_org"] as const;

export type ApiKeyMethod = (typeof API_KEY_METHODS)[number];

export const isApiKeyMethod = (
	method: AuthDetailsResponse["auth_method"],
): method is ApiKeyMethod =>
	(API_KEY_METHODS as readonly string[]).includes(method);

/**
 * A unique name for a key we mint, carrying the profile it belongs to, a UTC timestamp, and a
 * random suffix.
 *
 * Neither part is decoration. Key names are unique per account and the key being replaced still
 * holds its name while the replacement is minted, so a stable name fails the rotation outright
 * with `choose another unique name for api key`.
 *
 * The random suffix is there because a timestamp alone is not enough: at second precision two
 * rotations in the same second collide, which is easy to hit from a script and was hit while
 * testing this. Going to milliseconds only narrows the window, so the name carries four random
 * hex characters and the class of failure is gone rather than made less likely.
 */
export const mintedKeyName = (
	profile: string,
	now = new Date(),
	suffix = randomBytes(2).toString("hex"),
): string => {
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
	return `neon-cli-${profile}-${stamp}-${suffix}`;
};

export type KeyIdentity = {
	/** Something human-readable for `profile list`. An email when we can get one. */
	label?: string;
	/** The Neon user id, when the key belongs to a user rather than an organization. */
	userId?: string;
};

/**
 * What to record about a validated key.
 *
 * An organization-scoped key has no user, and `GET /users/me` answers `404 not allowed for
 * organization API keys` — so the account id is the only identity available, and asking for an
 * email would turn a perfectly good key into a failed `profile create`. The id is returned bare
 * rather than as "organization <id>": it already announces what it is through its `org-` prefix,
 * and `list` shows the scope in the next column.
 */
export const identityFromAuthDetails = (
	details: AuthDetailsResponse,
	email?: string,
): KeyIdentity => {
	if (details.auth_method === "api_key_org") {
		return { label: details.account_id };
	}
	return {
		...(email ? { label: email } : { label: details.account_id }),
		...(details.account_id ? { userId: details.account_id } : {}),
	};
};

/**
 * The message for a credential that authenticates but is not an API key — an OAuth access
 * token pasted in by mistake, most likely. It would work until it expired, then fail with no
 * way to refresh it, so it is refused at the point where the mistake is still obvious.
 */
export const notAnApiKeyMessage = (
	method: AuthDetailsResponse["auth_method"],
): string =>
	`That credential authenticates as "${method}", not an API key. Create a key with \`neon api-keys create --name <name>\`, or have one minted with \`neon profile create <name> --mint\`.`;
