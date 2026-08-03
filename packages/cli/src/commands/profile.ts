import { existsSync, readFileSync, rmSync } from "node:fs";
import prompts from "prompts";
import type yargs from "yargs";

import { getApiClient } from "../api.js";
import { revokeToken } from "../auth.js";
import { credentialInputs } from "../auth_selection.js";
import { isInsideConfigDir } from "../config.js";
import {
	API_KEY,
	credentialKind,
	mergeCredentials,
	readCredentials,
	type StoredCredentials,
	writeCredentials,
} from "../credentials.js";
import { isCi } from "../env.js";
import { log } from "../log.js";
import {
	identityFromAuthDetails,
	isApiKeyMethod,
	isGroupOrWorldReadable,
	mintedKeyName,
	notAnApiKeyMessage,
	readApiKeyFile,
} from "../profile_keys.js";
import {
	assertValidProfileName,
	DEFAULT_PROFILE,
	listProfiles,
	newProfileCredentialsPath,
	onlyDefaultRemains,
	profilesFilePath,
	readProfiles,
	resolveProfile,
	selectProfileName,
	upsertProfile,
} from "../profiles.js";
import type { CommonProps, ExtendedTokenSet } from "../types.js";
import { writeSecretFile } from "../utils/secure_file.js";
import { writer } from "../writer.js";
import { credentialsPathForName, usableCredential } from "./auth.js";

type ProfileProps = CommonProps & {
	configDir: string;
	profile?: string;
	oauthHost: string;
	clientId: string;
	allowUnsafeTls?: boolean;
};

export const command = "profiles";
export const aliases = ["profile"];
export const describe = "Manage named sets of Neon credentials";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 profiles <sub-command> [options]")
		.command(
			"list",
			"List profiles, the account each holds, and where its credentials live",
			(y) => y,
			async (args) => await list(args as unknown as ProfileProps),
		)
		.command(
			"set-key <name>",
			"Store an API key for a profile, creating it if needed",
			(y) =>
				y
					.positional("name", {
						describe: "Profile to store the key for",
						type: "string",
						demandOption: true,
					})
					.option("api-key-file", {
						describe:
							"Read the key from a file whose entire contents are the key",
						type: "string",
					})
					.example(
						"$0 profile set-key work",
						"Prompt for the key so it stays out of shell history",
					)
					.example(
						"$0 profile set-key work --api-key-file ~/keys/work",
						"Take the key from a file you already have",
					),
			async (args) =>
				await setKey(
					args as unknown as ProfileProps & {
						name: string;
						apiKeyFile?: string;
					},
				),
		)
		.command(
			"rotate-key <name>",
			"Mint a fresh API key for a profile and revoke the one it replaces",
			(y) =>
				y.positional("name", {
					describe: "Profile to rotate",
					type: "string",
					demandOption: true,
				}),
			async (args) =>
				await rotateKey(
					args as unknown as ProfileProps & { name: string },
				),
		)
		.command(
			"remove <name>",
			"Revoke a profile's token and remove it",
			(y) =>
				y
					.positional("name", {
						describe: "Profile to remove",
						type: "string",
						demandOption: true,
					})
					.option("yes", {
						alias: "y",
						describe: "Skip the confirmation prompt",
						type: "boolean",
						default: false,
					}),
			async (args) =>
				await remove(
					args as unknown as ProfileProps & {
						name: string;
						yes: boolean;
					},
				),
		)
		.demandCommand(1, "Run `neon profiles --help` to see the subcommands.");

export const handler = (_args: yargs.Arguments) => {
	/* subcommands only */
};

/**
 * What kind of credential a file holds, for display.
 *
 * A file that declares a kind we cannot read is reported as `invalid` with the reason logged,
 * rather than throwing: one broken profile must not hide every other row, and the whole point
 * of `list` is to show the state of things including the broken parts.
 */
const describeAuth = (
	stored: StoredCredentials | null,
	path: string,
): string => {
	if (stored === null) return "-";
	try {
		return credentialKind(stored, path) === API_KEY ? "api key" : "oauth";
	} catch (err) {
		log.warning(err instanceof Error ? err.message : String(err));
		return "invalid";
	}
};

const list = async (props: ProfileProps) => {
	const active = selectProfileName(props.profile);
	const rows = listProfiles(props.configDir).map((p) => {
		const stored = readCredentials(p.credentialsPath);
		const storedUserId =
			typeof stored?.user_id === "string" ? stored.user_id : undefined;
		return {
			active: p.name === active ? "*" : "",
			name: p.name,
			account: p.label ?? p.userId ?? storedUserId ?? "-",
			auth: describeAuth(stored, p.credentialsPath),
			// "available" rather than "signed in": a file existing has never proved that the
			// credential inside it still works, and for a key there is no session to be in.
			available: stored === null ? "no" : "yes",
			credentials: p.credentialsPath,
		};
	});

	writer(props).end(rows, {
		title: "Profiles",
		fields: [
			"active",
			"name",
			"account",
			"auth",
			"available",
			"credentials",
		],
	});
};

/**
 * Where a profile's credentials belong: its existing file when it has one, `credentials.json`
 * for `DEFAULT`, and the conventional `credentials.<name>.json` for a profile being created.
 */
const credentialsPathFor = (configDir: string, name: string): string => {
	if (readProfiles(configDir)?.profiles[name] || name === DEFAULT_PROFILE) {
		return credentialsPathForName(configDir, name);
	}
	return newProfileCredentialsPath(configDir, name);
};

/**
 * The key to store, from `--api-key-file`, `--api-key`, or a hidden prompt.
 *
 * Note this reads the key from the *flag* and never from `NEON_API_KEY`. Everywhere else those
 * are interchangeable, but "store this credential permanently" is not something an exported
 * environment variable should be able to answer — a `set-key` that silently wrote whatever
 * happened to be in the shell would be storing a key the user never named.
 */
const resolveKeyToStore = async (
	props: ProfileProps & { name: string; apiKeyFile?: string },
): Promise<string> => {
	const fromFlag = credentialInputs().apiKeyFlag.trim();
	const fromFile = props.apiKeyFile?.trim();

	if (fromFlag && fromFile) {
		throw new Error("Pass either --api-key or --api-key-file, not both.");
	}

	if (fromFile) {
		if (isGroupOrWorldReadable(fromFile)) {
			log.warning(
				"%s is readable by other users. This stores an owner-only copy, but the original stays exposed.",
				fromFile,
			);
		}
		return readApiKeyFile(fromFile);
	}

	if (fromFlag) return fromFlag;

	if (isCi() || !process.stdin.isTTY) {
		throw new Error(
			"No API key given, and there is no terminal to prompt on. Pass --api-key or --api-key-file.",
		);
	}

	const { key } = await prompts({
		type: "password",
		name: "key",
		message: `API key for profile "${props.name}"`,
	});
	const entered = typeof key === "string" ? key.trim() : "";
	if (entered === "") {
		throw new Error("No API key entered, so nothing was changed.");
	}
	return entered;
};

const setKey = async (
	props: ProfileProps & { name: string; apiKeyFile?: string },
) => {
	const { name } = props;
	assertValidProfileName(name);

	const apiKey = await resolveKeyToStore(props);

	// Verify before storing. A key that cannot authenticate is not worth writing to disk, and
	// the same call is the only way to learn whose key it is — the secret itself says nothing.
	const apiClient = getApiClient({ apiKey, apiHost: props.apiHost });
	const { data: details } = await apiClient.getAuthDetails();
	if (!isApiKeyMethod(details.auth_method)) {
		throw new Error(notAnApiKeyMessage(details.auth_method));
	}

	// Only a user key has a user to look up: `GET /users/me` answers 404 for an organization
	// key, so asking anyway would fail a `set-key` that is working perfectly.
	const email =
		details.auth_method === "api_key_user"
			? (await apiClient.getCurrentUserInfo()).data.email
			: undefined;
	const identity = identityFromAuthDetails(details, email);

	const credentialsPath = credentialsPathFor(props.configDir, name);
	const merged = mergeCredentials(
		readCredentials(credentialsPath),
		{
			type: API_KEY,
			api_key: apiKey,
			...(identity.userId ? { user_id: identity.userId } : {}),
		},
		// A key we did not mint has no discoverable id — `GET /api_keys` exposes no prefix, so
		// a stored secret cannot be matched back to a listing entry. Any id recorded for the
		// key this replaces must go, or a later rotation would revoke the wrong key.
		["key_id"],
	);
	writeCredentials(credentialsPath, merged);

	upsertProfile(props.configDir, name, {
		credentials: credentialsPath,
		...(identity.label ? { label: identity.label } : {}),
		...(identity.userId ? { userId: identity.userId } : {}),
	});

	log.info(
		'Stored an API key for profile "%s" (%s) in %s',
		name,
		identity.label ?? details.account_id,
		credentialsPath,
	);
	log.info("Use it with: neon --profile %s <command>", name);
};

const rotateKey = async (props: ProfileProps & { name: string }) => {
	const { name } = props;
	// Resolve first: an unknown profile must fail having minted nothing.
	const profile = resolveProfile(props.configDir, name);

	const credential = await usableCredential(props, profile.credentialsPath);
	if (credential === null) {
		throw new Error(
			`Profile "${name}" has no usable credential to mint a key with. Sign in with \`neon auth --profile ${name}\`, or store a key with \`neon profile set-key ${name}\`.`,
		);
	}

	const stored = readCredentials(profile.credentialsPath);
	const previousKeyId =
		typeof stored?.key_id === "number" ? stored.key_id : undefined;

	const minting = getApiClient({
		apiKey: credential.apiKey,
		apiHost: props.apiHost,
	});
	const { data: created } = await minting.createApiKey(mintedKeyName(name));
	log.info("Minted %s (id %d)", created.name, created.id);

	// Store before revoking. If the write fails the old key is still valid, so the profile
	// keeps working — and the new key is named in the error rather than silently orphaned on
	// the account with no way to find it again.
	try {
		writeCredentials(
			profile.credentialsPath,
			mergeCredentials(stored, {
				type: API_KEY,
				api_key: created.key,
				key_id: created.id,
			}),
		);
	} catch (err) {
		log.error(
			"Minted key %d but could not write %s. Revoke it with: neon api DELETE /api_keys/%d",
			created.id,
			profile.credentialsPath,
			created.id,
		);
		throw err;
	}
	log.info("Stored it in %s", profile.credentialsPath);

	if (previousKeyId === undefined) {
		log.info(
			"No previous key id was recorded, so nothing was revoked. A key stored with `set-key` cannot be matched to a listing entry; check `neon api GET /api_keys`.",
		);
		return;
	}

	// Revoke with the new key. The old one may be exactly what stopped working, which is the
	// usual reason to rotate in the first place.
	const rotated = getApiClient({
		apiKey: created.key,
		apiHost: props.apiHost,
	});
	try {
		await rotated.revokeApiKey(previousKeyId);
		log.info("Revoked the previous key (id %d)", previousKeyId);
	} catch (err) {
		log.warning(
			"Stored the new key, but could not revoke the previous one (id %d): %s. Revoke it with: neon api DELETE /api_keys/%d",
			previousKeyId,
			err instanceof Error ? err.message : "unknown error",
			previousKeyId,
		);
	}
};

const remove = async (props: ProfileProps & { name: string; yes: boolean }) => {
	const { name } = props;
	// Resolve before touching anything: an unknown name must fail having deleted nothing.
	const profile = resolveProfile(props.configDir, name);

	if (!props.yes) {
		if (isCi()) {
			throw new Error(
				"Refusing to remove a profile without confirmation in CI. Pass --yes.",
			);
		}
		const who = profile.label ?? profile.userId ?? "unknown account";
		const { ok } = await prompts({
			type: "confirm",
			name: "ok",
			message: `Remove profile "${name}" (${who})?`,
			initial: false,
		});
		if (!ok) {
			log.info("Cancelled.");
			return;
		}
	}

	// 1. Revoke upstream, so the credential dies rather than merely becoming unreachable by us.
	//    Best-effort: a profile is often removed precisely because its access already broke.
	const stored = readCredentials(profile.credentialsPath);
	const holdsApiKey =
		stored !== null &&
		credentialKind(stored, profile.credentialsPath) === API_KEY;

	if (holdsApiKey) {
		// An API key cannot be revoked from here. `GET /api_keys` exposes no prefix, so a
		// stored secret cannot be matched back to a listing entry — even one we minted and
		// recorded a `key_id` for would need that id to survive a removal that deletes it.
		// Deleting the file locally would otherwise look like the key was destroyed.
		log.warning(
			'Profile "%s" holds an API key, which stays live on the account — removing it here only makes it unreachable from this machine. Revoke it with: neon api GET /api_keys',
			name,
		);
	} else {
		const revoked = await revokeStoredToken(profile.credentialsPath, props);
		log.info(
			revoked
				? "Revoked the OAuth token"
				: "Could not revoke the OAuth token — removing locally anyway",
		);
	}

	// 2. Delete the credentials file only if we created it. A profile pointing outside the
	//    config directory was adopted from elsewhere; unlink it and say so, because the
	//    secret is still on disk and silence would imply otherwise.
	if (existsSync(profile.credentialsPath)) {
		if (isInsideConfigDir(props.configDir, profile.credentialsPath)) {
			rmSync(profile.credentialsPath);
			log.info("Deleted %s", profile.credentialsPath);
		} else {
			log.info(
				"Left %s on disk — not created by neon",
				profile.credentialsPath,
			);
		}
	}

	// 3. Drop the entry, and the file once nothing but DEFAULT is left — the mirror image
	//    of creating it lazily, so a single-account install ends up with no profiles.json.
	const path = profilesFilePath(props.configDir);
	const file = readProfiles(props.configDir);
	if (file?.profiles[name]) {
		delete file.profiles[name];
		if (onlyDefaultRemains(file)) {
			rmSync(path);
			log.info('Removed "%s" — no profiles left, deleted %s', name, path);
		} else {
			writeSecretFile(path, `${JSON.stringify(file, null, 2)}\n`);
			log.info('Removed "%s" from %s', name, path);
		}
	} else if (name === DEFAULT_PROFILE) {
		log.info("Signed out of DEFAULT");
	}
};

const revokeStoredToken = async (
	credentialsPath: string,
	props: ProfileProps,
): Promise<boolean> => {
	if (!existsSync(credentialsPath)) return false;
	let tokenSet: ExtendedTokenSet;
	try {
		tokenSet = JSON.parse(readFileSync(credentialsPath, "utf8"));
	} catch {
		return false;
	}
	return await revokeToken(
		{
			oauthHost: props.oauthHost,
			clientId: props.clientId,
			...(props.allowUnsafeTls
				? { allowUnsafeTls: props.allowUnsafeTls }
				: {}),
		},
		tokenSet,
	);
};
