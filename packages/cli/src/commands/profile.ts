import { existsSync, readFileSync, rmSync } from "node:fs";
import prompts from "prompts";
import type yargs from "yargs";

import { getApiClient, type NeonApiClient } from "../api.js";
import { auth, revokeToken } from "../auth.js";
import { credentialInputs } from "../auth_selection.js";
import { isInsideConfigDir } from "../config.js";
import {
	API_KEY,
	apiKeyCredentials,
	credentialKind,
	describeScope,
	type KeyScope,
	readCredentials,
	type StoredCredentials,
	scopeOf,
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
import { noPassthrough, single } from "../utils/flags.js";
import { writeSecretFile } from "../utils/secure_file.js";
import { writer } from "../writer.js";
import { authFlow, credentialsPathForName, usableCredential } from "./auth.js";

type ProfileProps = CommonProps & {
	configDir: string;
	profile?: string;
	oauthHost: string;
	clientId: string;
	allowUnsafeTls?: boolean;
	forceAuth?: boolean;
};

type CreateProps = ProfileProps & {
	name: string;
	apiKeyFile?: string;
	apiKeyStdin?: boolean;
	mint?: boolean;
	orgId?: string;
	projectId?: string;
	force: boolean;
};

export const command = "profile";
export const aliases = ["profiles"];
export const describe = "Manage named sets of Neon credentials";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 profile <sub-command> [options]")
		.command(
			"list",
			"List profiles, the account each holds, and where its credentials live",
			(y) => y,
			async (args) => await list(args as unknown as ProfileProps),
		)
		.command(
			"create <name>",
			"Create a profile, holding either a browser sign-in or an API key",
			(y) =>
				y
					.positional("name", {
						describe: "Name for the new profile",
						type: "string",
						demandOption: true,
					})
					.options({
						"api-key-file": {
							describe:
								"Store the API key in this file, whose entire contents are the key",
							type: "string",
							coerce: single("api-key-file"),
						},
						"api-key-stdin": {
							describe:
								"Read the API key from stdin, or prompt for it in a terminal",
							type: "boolean",
							default: false,
						},
						mint: {
							describe:
								"Sign in once in the browser, then store a freshly minted API key and nothing else",
							type: "boolean",
							default: false,
						},
						"org-id": {
							describe:
								"With --mint, mint a key for this organization instead of your account",
							type: "string",
							coerce: single("org-id"),
						},
						"project-id": {
							describe:
								"With --mint, mint a key that can access only this project",
							type: "string",
							coerce: single("project-id"),
						},
						force: {
							describe:
								"Replace the profile if it already exists",
							type: "boolean",
							default: false,
						},
					})
					// A project-scoped key is already an organization key, and its org is
					// derived from the project rather than chosen — same rule as `api-keys`.
					.conflicts("org-id", "project-id")
					.check(noPassthrough("profile create"))
					.example(
						"$0 profile create work",
						"Sign in with the browser, like `neon auth --profile work`",
					)
					.example(
						"$0 profile create work --api-key napi_...",
						"Store a key you already have",
					)
					.example(
						"$0 profile create ci --mint --org-id org-abc-123",
						"One browser sign-in, then an org-scoped key and no session left behind",
					),
			async (args) => await create(args as unknown as CreateProps),
		)
		.command(
			"rotate-key <name>",
			"Mint a fresh API key for a profile, at the same scope, and revoke the one it replaces",
			(y) =>
				y
					.positional("name", {
						describe: "Profile to rotate",
						type: "string",
						demandOption: true,
					})
					.check(noPassthrough("profile rotate-key")),
			async (args) =>
				await rotateKey(
					args as unknown as ProfileProps & { name: string },
				),
		)
		.command(
			"remove <name>",
			"Revoke a profile's credential where possible, and remove it",
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
		.demandCommand(1, "Run `neon profile --help` to see the subcommands.");

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
		const auth = describeAuth(stored, p.credentialsPath);
		return {
			active: p.name === active ? "*" : "",
			name: p.name,
			account: p.label ?? p.userId ?? storedUserId ?? "-",
			auth,
			// Only a key carries a scope. An OAuth session reaches whatever its account does.
			scope:
				stored !== null && auth === "api key"
					? describeScope(scopeOf(stored))
					: "-",
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
			"scope",
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

/** Refuse to overwrite an existing profile unless asked to. */
const assertReplaceable = (props: CreateProps): void => {
	const { name, configDir, force } = props;
	if (force) return;
	const declared = readProfiles(configDir)?.profiles[name];
	const path = credentialsPathFor(configDir, name);
	if (declared || (name === DEFAULT_PROFILE && existsSync(path))) {
		throw new Error(
			`Profile "${name}" already exists. Pass --force to replace its credential, or \`neon profile rotate-key ${name}\` to mint a fresh key for it.`,
		);
	}
};

/**
 * The key to store, from `--api-key`, `--api-key-file`, or stdin.
 *
 * Note this reads the key from the *flag* and never from `NEON_API_KEY`. Everywhere else those
 * are interchangeable, but "store this credential permanently" is not something an exported
 * environment variable should be able to answer — a `create` that silently wrote whatever
 * happened to be in the shell would be storing a key the user never named.
 */
const resolveKeyToStore = async (props: CreateProps): Promise<string> => {
	const fromFlag = credentialInputs().apiKeyFlag.trim();
	const fromFile = props.apiKeyFile?.trim();
	const fromStdin = props.apiKeyStdin === true;

	const given = [
		fromFlag ? "--api-key" : null,
		fromFile ? "--api-key-file" : null,
		fromStdin ? "--api-key-stdin" : null,
	].filter((flag): flag is string => flag !== null);

	if (given.length > 1) {
		throw new Error(
			`Pass only one of ${given.join(", ")} — they are three ways to supply the same key.`,
		);
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

	// `--api-key-stdin` covers both a pipe and a person: piped input is read, and a terminal
	// gets a hidden prompt. Either way the key never appears in argv, where `ps` and shell
	// history would both keep it.
	if (fromStdin) return await readKeyFromStdin(props.name);

	throw new Error(
		`Nothing to store for profile "${props.name}". Pass --api-key, --api-key-file, or --api-key-stdin — or --mint to have one minted, or no flags at all to sign in with the browser.`,
	);
};

const readKeyFromStdin = async (name: string): Promise<string> => {
	if (process.stdin.isTTY) {
		if (isCi()) {
			throw new Error(
				"Refusing to prompt for an API key in CI. Pipe it to --api-key-stdin instead.",
			);
		}
		const { key } = await prompts({
			type: "password",
			name: "key",
			message: `API key for profile "${name}"`,
		});
		const entered = typeof key === "string" ? key.trim() : "";
		if (entered === "") {
			throw new Error("No API key entered, so nothing was changed.");
		}
		return entered;
	}

	const piped = readFileSync(0, "utf8").trim();
	if (piped === "") {
		throw new Error(
			"Nothing arrived on stdin, so there is no API key to store.",
		);
	}
	return piped;
};

/**
 * Confirm a key works and find out whose it is, before it is written anywhere.
 *
 * `getAuthDetails` rather than `GET /users/me`: an organization key gets `404 not allowed for
 * organization API keys` from the latter, so asking would fail a perfectly good key.
 */
const verifyKey = async (
	props: CommonProps,
	apiKey: string,
): Promise<{ label?: string; userId?: string; apiClient: NeonApiClient }> => {
	const apiClient = getApiClient({ apiKey, apiHost: props.apiHost });
	const { data: details } = await apiClient.getAuthDetails();
	if (!isApiKeyMethod(details.auth_method)) {
		throw new Error(notAnApiKeyMessage(details.auth_method));
	}
	const email =
		details.auth_method === "api_key_user"
			? (await apiClient.getCurrentUserInfo()).data.email
			: undefined;
	return { ...identityFromAuthDetails(details, email), apiClient };
};

const create = async (props: CreateProps) => {
	const { name } = props;
	assertValidProfileName(name);
	assertReplaceable(props);

	if (props.mint) {
		await createByMinting(props);
		return;
	}

	if ((props.orgId ?? props.projectId) !== undefined) {
		throw new Error(
			"--org-id and --project-id only apply with --mint: they choose what a key we mint can reach, and a key you supply already has a scope.",
		);
	}

	const wantsKey =
		credentialInputs().apiKeyFlag.trim() !== "" ||
		props.apiKeyFile !== undefined ||
		props.apiKeyStdin === true;

	// No key and no --mint means a browser sign-in, which is exactly `neon auth --profile`.
	// Delegating rather than reimplementing keeps one OAuth path in the CLI.
	if (!wantsKey) {
		await authFlow({ ...props, _: ["auth"], profile: name });
		log.info("Use it with: neon --profile %s <command>", name);
		return;
	}

	const apiKey = await resolveKeyToStore(props);
	const identity = await verifyKey(props, apiKey);
	const credentialsPath = credentialsPathFor(props.configDir, name);

	writeCredentials(
		credentialsPath,
		apiKeyCredentials({
			apiKey,
			...(identity.userId !== undefined
				? { userId: identity.userId }
				: {}),
		}),
	);
	recordProfile(props, name, credentialsPath, identity);

	log.info(
		'Stored an API key for profile "%s" (%s) in %s',
		name,
		identity.label ?? "unknown account",
		credentialsPath,
	);
	// A key we did not mint has no discoverable id: `GET /api_keys` exposes no prefix, so a
	// stored secret cannot be matched back to a listing entry. Say so now rather than when a
	// rotation cannot clean up after itself.
	log.info(
		"Its scope is whatever it was created with, and `rotate-key` cannot revoke it later — only keys minted here record an id. `neon api-keys list` shows what exists.",
	);
	log.info("Use it with: neon --profile %s <command>", name);
};

const recordProfile = (
	props: CreateProps,
	name: string,
	credentialsPath: string,
	identity: { label?: string; userId?: string },
): void => {
	upsertProfile(props.configDir, name, {
		credentials: credentialsPath,
		...(identity.label ? { label: identity.label } : {}),
		...(identity.userId ? { userId: identity.userId } : {}),
	});
};

/**
 * Sign in once, mint a key, keep only the key.
 *
 * This is the reason to prefer a key-backed profile at all: after it, nothing about the profile
 * can trigger a browser. The OAuth session is a means to an end and is revoked at the end of
 * it, so no half-forgotten login is left behind — which also means the file holds exactly one
 * credential, for exactly one account.
 */
const createByMinting = async (props: CreateProps) => {
	const { name } = props;

	// `authFlow` refuses to open a browser in CI; minting calls `auth` directly and so has to
	// make the same check itself, or this would sit waiting for a login nobody can complete.
	if (isCi() && props.forceAuth !== true) {
		throw new Error(
			`--mint needs a browser sign-in, which cannot happen in CI. Mint the key with \`neon api-keys create\` and store it with \`neon profile create ${name} --api-key-stdin\`.`,
		);
	}

	const scope = await resolveMintScope(props);

	const tokenSet = await auth({
		oauthHost: props.oauthHost,
		clientId: props.clientId,
		...(props.allowUnsafeTls
			? { allowUnsafeTls: props.allowUnsafeTls }
			: {}),
	});
	const session = getApiClient({
		apiKey: tokenSet.access_token ?? "",
		apiHost: props.apiHost,
	});

	const created = await mintKey(session, name, scope);
	const identity = await verifyKey(props, created.key);
	const credentialsPath = credentialsPathFor(props.configDir, name);

	try {
		writeCredentials(
			credentialsPath,
			apiKeyCredentials({
				apiKey: created.key,
				keyId: created.id,
				...(identity.userId !== undefined
					? { userId: identity.userId }
					: {}),
				scope,
			}),
		);
	} catch (err) {
		log.error(
			"Minted key %d but could not write %s. Revoke it with: neon api-keys revoke %d%s",
			created.id,
			credentialsPath,
			created.id,
			scope.orgId ? ` --org-id ${scope.orgId}` : "",
		);
		throw err;
	}
	recordProfile(props, name, credentialsPath, identity);

	log.info(
		'Minted %s for profile "%s" (%s, %s) and stored it in %s',
		created.name,
		name,
		identity.label ?? "unknown account",
		describeScope(scope),
		credentialsPath,
	);

	// Best-effort: a session we cannot revoke is worth saying out loud rather than leaving the
	// user to believe `--mint` left nothing behind.
	const revoked = await revokeToken(
		{
			oauthHost: props.oauthHost,
			clientId: props.clientId,
			...(props.allowUnsafeTls
				? { allowUnsafeTls: props.allowUnsafeTls }
				: {}),
		},
		tokenSet,
	);
	log.info(
		revoked
			? "Signed the browser session back out, so the profile holds only the key."
			: "Could not sign the browser session back out; the key is stored and in use regardless.",
	);
	log.info("Use it with: neon --profile %s <command>", name);
};

/**
 * The scope to mint at, resolving a project to the organization that owns it.
 *
 * A project-scoped key exists only on the organization endpoint, so the org has to be looked up
 * rather than asked for — `--project-id` alone would otherwise fail for a reason invisible from
 * the command line.
 */
const resolveMintScope = async (props: CreateProps): Promise<KeyScope> => {
	if (props.projectId === undefined) {
		return props.orgId !== undefined ? { orgId: props.orgId } : {};
	}
	// Resolving the project needs a credential, and at this point the profile has none. Use
	// whatever this invocation itself authenticated with; `--api-key` or an existing profile
	// both work, and without either the message says what to pass.
	if (!props.apiKey) {
		throw new Error(
			`--project-id has to look up which organization owns ${props.projectId}, which needs a credential. Pass --org-id instead, or run this with --api-key or --profile.`,
		);
	}
	const {
		data: { project },
	} = await props.apiClient.getProject(props.projectId);
	if (!project.org_id) {
		throw new Error(
			`Project ${props.projectId} does not belong to an organization, so it cannot have a project-scoped API key. Omit --project-id, or pass --org-id.`,
		);
	}
	return { orgId: project.org_id, projectId: props.projectId };
};

/**
 * Mint a key at the given scope and refuse anything that came back different.
 *
 * A 2xx is not enough. A response with no `key` leaves a live credential the user can never
 * see, and a `project_id` that does not match would mean storing a credential whose reach we
 * announced wrongly. Both are withdrawn before throwing.
 */
const mintKey = async (
	client: NeonApiClient,
	profile: string,
	scope: KeyScope,
): Promise<{ id: number; key: string; name: string }> => {
	const keyName = mintedKeyName(profile);
	const { data } = scope.orgId
		? await client.createOrgApiKey(scope.orgId, {
				key_name: keyName,
				...(scope.projectId ? { project_id: scope.projectId } : {}),
			})
		: await client.createApiKey({ key_name: keyName });

	// Only the organization endpoint's response carries `project_id`, so narrow rather than
	// assert: an account key legitimately has no such field, and a *missing* one is exactly
	// what "unscoped" looks like.
	const issuedProject =
		"project_id" in data && typeof data.project_id === "string"
			? data.project_id
			: undefined;

	const problem =
		typeof data.key !== "string" || data.key.trim() === ""
			? "Neon returned no key."
			: issuedProject !== scope.projectId
				? `Neon returned a key scoped to ${issuedProject ?? "nothing"} rather than ${scope.projectId ?? "the whole organization"}.`
				: null;

	if (problem === null) {
		return { id: data.id, key: data.key, name: data.name };
	}

	const withdrawn = await withdrawKey(client, scope, data.id);
	throw new Error(
		`${problem} ${
			withdrawn
				? "The key has been revoked; nothing was stored."
				: `The key could NOT be revoked and may still be live. Remove it with \`neon api-keys revoke ${data.id}${scope.orgId ? ` --org-id ${scope.orgId}` : ""}\`.`
		}`,
	);
};

/** Best-effort withdrawal of a key we are refusing to store. Never throws. */
const withdrawKey = async (
	client: NeonApiClient,
	scope: KeyScope,
	keyId: number | undefined,
): Promise<boolean> => {
	if (!Number.isSafeInteger(keyId) || (keyId as number) <= 0) return false;
	try {
		const { data } = scope.orgId
			? await client.revokeOrgApiKey(scope.orgId, keyId as number)
			: await client.revokeApiKey(keyId as number);
		// Check which key the response names: a `revoked: true` for some other id is not
		// evidence that the one we issued is gone.
		return data.revoked === true && data.id === keyId;
	} catch (err) {
		log.error(
			"Failed to revoke API key %d: %s",
			keyId,
			err instanceof Error ? err.message : String(err),
		);
		return false;
	}
};

const rotateKey = async (props: ProfileProps & { name: string }) => {
	const { name } = props;
	// Resolve first: an unknown profile must fail having minted nothing.
	const profile = resolveProfile(props.configDir, name);

	const credential = await usableCredential(props, profile.credentialsPath);
	if (credential === null) {
		throw new Error(
			`Profile "${name}" has no usable credential to mint with. Replace it with \`neon profile create ${name} --mint --force\`.`,
		);
	}

	const stored = readCredentials(profile.credentialsPath);
	const scope = stored !== null ? scopeOf(stored) : {};
	const previousKeyId =
		typeof stored?.key_id === "number" ? stored.key_id : undefined;

	const minting = getApiClient({
		apiKey: credential.apiKey,
		apiHost: props.apiHost,
	});

	// Neon only lets a *personal* credential mint organization keys, so an org-scoped profile
	// cannot mint its own replacement. Checked up front: letting it through produces
	// "This endpoint requires a personal API key" from a command the user has no reason to
	// connect to that rule, having named nothing but a profile.
	if (scope.orgId !== undefined) {
		const { data: details } = await minting.getAuthDetails();
		if (details.auth_method === "api_key_org") {
			throw new Error(
				`Profile "${name}" holds an organization key, and only a personal credential can mint organization keys — so it cannot mint its own replacement. Sign in and mint one with \`neon profile create ${name} --mint ${scope.projectId ? `--project-id ${scope.projectId}` : `--org-id ${scope.orgId}`} --force\`.`,
			);
		}
	}

	// Mint at the recorded scope. Minting an account key to replace an org or project one
	// would quietly widen everything the profile can reach.
	const created = await mintKey(minting, name, scope);
	log.info(
		"Minted %s (id %d, %s)",
		created.name,
		created.id,
		describeScope(scope),
	);

	// Store before revoking. If the write fails the old key is still valid, so the profile
	// keeps working — and the new key is named in the error rather than silently orphaned on
	// the account with no way to find it again.
	try {
		writeCredentials(
			profile.credentialsPath,
			apiKeyCredentials({
				apiKey: created.key,
				keyId: created.id,
				...(typeof stored?.user_id === "string"
					? { userId: stored.user_id }
					: {}),
				scope,
			}),
		);
	} catch (err) {
		log.error(
			"Minted key %d but could not write %s. Revoke it with: neon api-keys revoke %d%s",
			created.id,
			profile.credentialsPath,
			created.id,
			scope.orgId ? ` --org-id ${scope.orgId}` : "",
		);
		throw err;
	}
	log.info("Stored it in %s", profile.credentialsPath);

	if (previousKeyId === undefined) {
		log.warning(
			"No previous key id was recorded, so the key this replaces is still live. It was supplied rather than minted here, and `GET /api_keys` exposes no prefix to match it by — find it with `neon api-keys list`.",
		);
		return;
	}

	// Revoke with the new key. The old one may be exactly what stopped working, which is the
	// usual reason to rotate in the first place.
	const rotated = getApiClient({
		apiKey: created.key,
		apiHost: props.apiHost,
	});
	if (await withdrawKey(rotated, scope, previousKeyId)) {
		log.info("Revoked the previous key (id %d)", previousKeyId);
		return;
	}
	log.warning(
		"Stored the new key, but could not revoke the previous one (id %d) — it may still be live. Revoke it with: neon api-keys revoke %d%s",
		previousKeyId,
		previousKeyId,
		scope.orgId ? ` --org-id ${scope.orgId}` : "",
	);
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

	// 1. Revoke upstream where we can, so the credential dies rather than merely becoming
	//    unreachable by us. Best-effort: a profile is often removed precisely because its
	//    access already broke.
	const stored = readCredentials(profile.credentialsPath);
	const holdsApiKey =
		stored !== null &&
		credentialKind(stored, profile.credentialsPath) === API_KEY;

	if (holdsApiKey) {
		const keyId =
			typeof stored.key_id === "number" ? stored.key_id : undefined;
		const scope = scopeOf(stored);
		if (keyId === undefined) {
			// A key we did not mint has no id we can match it by, so it outlives its profile.
			// Deleting the file quietly would imply the credential had been destroyed.
			log.warning(
				'Profile "%s" holds an API key that was supplied rather than minted here, so it stays live on the account — find it with `neon api-keys list`.',
				name,
			);
		} else {
			const client = getApiClient({
				apiKey: stored.api_key as string,
				apiHost: props.apiHost,
			});
			log.info(
				(await withdrawKey(client, scope, keyId))
					? `Revoked the API key (id ${keyId})`
					: `Could not revoke the API key (id ${keyId}) — it may still be live. Remove it with: neon api-keys revoke ${keyId}${scope.orgId ? ` --org-id ${scope.orgId}` : ""}`,
			);
		}
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
