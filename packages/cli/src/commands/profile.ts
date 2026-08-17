import { existsSync, readFileSync, rmSync } from "node:fs";
import { credentialInputs } from "@neon-internals/cli-core/auth_selection";
import {
	CRED_STORAGE_FILE,
	CRED_STORAGE_KEYRING,
} from "@neon-internals/cli-core/cli_config";
import {
	type CredentialDeleteResult,
	KEYRING_SERVICE,
	keyringAccount,
} from "@neon-internals/cli-core/credential_store";
import {
	API_KEY,
	apiKeyCredentials,
	type CredentialLocation,
	credentialLabel,
	describeScope,
	interpretCredentials,
	type KeyScope,
	type StoredCredentials,
	scopeOf,
} from "@neon-internals/cli-core/credentials";
import {
	credentialsPath,
	isOwnedCredentialPath,
} from "@neon-internals/cli-core/paths";
import {
	assertProfilesUsable,
	assertValidProfileName,
	canDropProfilesFile,
	credentialsDisplay,
	DEFAULT_PROFILE,
	isKeyringPointer,
	KEYRING_CREDENTIALS,
	listProfiles,
	locationForName,
	locationOf,
	newProfileLocation,
	profilesFilePath,
	profilesUsingPath,
	readProfiles,
	resolveProfile,
	selectProfileName,
	upsertProfile,
} from "@neon-internals/cli-core/profiles";
import { writeSecretFile } from "@neon-internals/cli-core/secure_file";
import prompts from "prompts";
import type yargs from "yargs";
import { getApiClient, isNeonApiError, type NeonApiClient } from "../api.js";
import { auth, revokeToken } from "../auth.js";
import { setAuthContext } from "../auth_context.js";
import { storeFor } from "../credential_io.js";
import { isCi } from "../env.js";
import { log } from "../log.js";
import {
	identityFromAuthDetails,
	isApiKeyMethod,
	mintedKeyName,
	notAnApiKeyMessage,
} from "../profile_keys.js";
import {
	type OutgoingCredential,
	readOutgoingCredential,
	retirePreviousCredential,
	revokeTokenSet,
	withdrawKey,
} from "../retire_credential.js";
import type { CommonProps } from "../types.js";
import { noPassthrough, single } from "../utils/flags.js";
import { writer } from "../writer.js";
import { orgIdForProject } from "./api_keys.js";
import { authFlow, usableCredential } from "./auth.js";

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
	mint?: boolean;
	orgId?: string;
	projectId?: string;
	keyring?: boolean;
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
			(y) => y.strict().check(noPassthrough("profile list")),
			async (args) => await list(args as unknown as ProfileProps),
		)
		.command(
			"create <name>",
			"Create a profile. It holds either a browser sign-in or an API key, never both",
			(y) =>
				y
					.positional("name", {
						describe: "Name for the new profile",
						type: "string",
						demandOption: true,
					})
					.options({
						// `create` deliberately ignores NEON_API_KEY (see `resolveKeyToStore`),
						// but the global option renders "default: NEON_API_KEY" into this help
						// screen — so a user with it exported would expect it to be stored.
						"api-key": {
							describe:
								'API key to store, or "-" to read it from stdin',
							defaultDescription:
								"none; this command ignores NEON_API_KEY",
							type: "string",
							// Force the next token to be taken as the value. Without it yargs
							// reads the `-` in `--api-key -` as an option of its own and reports
							// "Unknown command: -", so only the `=` form would bind.
							nargs: 1,
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
						keyring: {
							describe:
								"Store the credential in the OS keyring. Per profile; later create without the flag stays there. See `neon profile list`.",
							type: "boolean",
						},
						// Shipped on create. The meaning is now the default, so the flag is
						// refused with a recovery line rather than "Unknown argument".
						force: {
							hidden: true,
							type: "boolean",
						},
					})
					// A project-scoped key is already an organization key, and its org is
					// derived from the project rather than chosen — same rule as `api-keys`.
					.conflicts("org-id", "project-id")
					.strict()
					.check((argv) => {
						noPassthrough("profile create")(argv);
						if (argv.force === true) {
							const name =
								typeof argv.name === "string"
									? argv.name
									: "NAME";
							throw new Error(
								`--force is no longer a flag. \`neon profile create ${name}\` always replaces an existing profile and revokes the credential it held. Drop --force.`,
							);
						}
						return true;
					})
					.example(
						"$0 profile create work",
						"Sign in with the browser, like `neon auth --profile work`",
					)
					.example(
						'$0 profile create work --api-key "$KEY"',
						"Store a key you already have",
					)
					.example(
						'echo "$KEY" | $0 profile create work --api-key -',
						"Or pipe it, so it never reaches the process arguments",
					)
					.example(
						"$0 profile create ci --mint --org-id org-abc-123",
						"One browser sign-in, then an org-scoped key and no session left behind",
					)
					.example(
						"$0 profile create work --keyring",
						"Store the credential in the OS keyring instead of a file",
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
					.strict()
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
					})
					.strict()
					.check(noPassthrough("profile remove")),
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
 * Refuse a global credential flag that a `profile` subcommand cannot honour.
 *
 * These commands name their target as a positional and authenticate as that profile, so both
 * `--profile` and `--api-key` have nothing to select here and were silently dropped — which is
 * precisely the class of bug this command family exists to stop. `.strict()` cannot catch
 * either, because both are global options and yargs has already accepted them.
 *
 * No "did you mean". The suggestion this used to make was built from the flag rather than the
 * positional, so it renamed the target: `profile remove work --profile other` answered "did you
 * mean `neon profile remove other`". Since the name is a required positional, that was wrong in
 * every case it fired, and on `remove` it was copy-pasteable destructive advice for an account
 * the user had not mentioned.
 */
const rejectProfileFlag = (
	props: { profile?: string; name: string },
	sub: string,
): void => {
	const named = props.profile?.trim();
	if (!named) return;
	throw new Error(
		`--profile does not apply to \`profile ${sub}\`, which takes the profile name as an argument. You passed both "${props.name}" and --profile ${named}; drop --profile.`,
	);
};

/**
 * Refuse `--api-key` on a subcommand that authenticates as the profile it was given.
 *
 * The mirror image of the flag above, and it was the one left silent: `profile remove work
 * --api-key napi_…` ignored the key, used the stored one, and reported a revoke failure against
 * a credential the user had not passed. This PR exists because a dropped credential flag chose
 * the wrong account; leaving that unsaid on the commands that manage credentials would be the
 * same bug with the arguments swapped.
 */
const rejectApiKeyFlag = (sub: string, instead?: string): void => {
	if (credentialInputs().apiKeyFlag.trim() === "") return;
	throw new Error(
		`--api-key does not apply to \`profile ${sub}\`, which uses the credential the profile already holds.${instead ? ` ${instead}` : ""}`,
	);
};

/**
 * What kind of credential a file holds, for display.
 *
 * A file that declares a kind we cannot read is reported as `invalid` with the reason logged,
 * rather than throwing: one broken profile must not hide every other row, and the whole point
 * of `list` is to show the state of things including the broken parts.
 */
const hintStore = (storage: string): "file" | "keyring" =>
	storage === "keyring" ? "keyring" : "file";

const describeAuth = (
	stored: StoredCredentials | null,
	at: CredentialLocation,
	store: "file" | "keyring" = "file",
): string => {
	if (stored === null) return "-";
	try {
		// `interpretCredentials`, not `credentialKind`: the kind is a declaration, and a file
		// declaring `api_key` with no key satisfies it. Reporting that as a working API-key
		// profile is the wrong answer for the one command run to find out what is broken.
		return interpretCredentials(stored, at, store).kind === API_KEY
			? "api key"
			: "oauth";
	} catch (err) {
		log.warning(err instanceof Error ? err.message : String(err));
		return "invalid";
	}
};

/**
 * One row's view of a credentials file.
 *
 * Reports a damaged file as `invalid` and carries on, because one broken profile must not take
 * the whole listing with it — and unlike the authenticating path, listing has nothing to
 * recover, so the row itself is the report.
 *
 * One column answers "can this be used". A file whose JSON parses but whose `type` is
 * unreadable used to show `File: ok` beside `Auth: invalid`, so the column a user scans to find
 * the broken profile pointed at a different row than the one that was broken.
 */
const inspectForListing = (
	configDir: string,
	at: CredentialLocation,
): {
	stored: StoredCredentials | null;
	auth: string;
	file: string;
	storage: string;
} => {
	const listing = storeFor(configDir).inspect(at);
	if (listing.reason !== undefined) log.warning(listing.reason);
	if (listing.credentials === null) {
		return {
			stored: null,
			auth: "-",
			file: listing.file,
			storage: listing.storage,
		};
	}
	const auth = describeAuth(
		listing.credentials,
		at,
		hintStore(listing.storage),
	);
	return {
		stored: listing.credentials,
		auth,
		file: auth === "invalid" ? "invalid" : listing.file,
		storage: listing.storage,
	};
};

const list = async (props: ProfileProps) => {
	// Reading files on disk; a key would authenticate nothing here.
	rejectApiKeyFlag("list");
	// `list` is the one subcommand where `--profile` means something: it marks the active row.
	// It still has to be a profile that exists, or the marker silently lands on nothing.
	const active = selectProfileName(props.profile);
	if (props.profile !== undefined && props.profile.trim() !== "") {
		resolveProfile(props.configDir, active);
	}
	const rows = listProfiles(props.configDir).map((p) => {
		const { stored, auth, file, storage } = inspectForListing(
			props.configDir,
			locationOf(p),
		);
		const storedUserId =
			typeof stored?.user_id === "string" ? stored.user_id : undefined;
		return {
			active: p.name === active ? "*" : "",
			name: p.name,
			account: p.label ?? p.userId ?? storedUserId ?? "-",
			auth,
			scope:
				auth === "oauth"
					? describeScope({})
					: stored !== null && auth === "api key"
						? describeScope(scopeOf(stored))
						: "-",
			file,
			storage,
			credentials: credentialsDisplay(p),
		};
	});

	writer(props).end(rows, {
		title: "Profiles",
		fields: ["active", "name", "account", "auth", "scope", "credentials"],
	});
};

const locationForCreate = (
	configDir: string,
	name: string,
	keyring?: boolean,
): CredentialLocation => {
	// Metadata we cannot read makes this a guess: `credentials.<name>.json` is a convention,
	// and the entry that would say whether it is this account's file is exactly what is
	// unreadable. Guessing here is what let a replacement overwrite a file and revoke its key
	// before `upsertProfile` refused the same metadata.
	assertProfilesUsable(configDir, name);
	const declared = readProfiles(configDir)?.profiles[name];
	const pointer =
		declared !== undefined && isKeyringPointer(declared.credentials);
	if (keyring === true || pointer) {
		return { profile: name, storage: CRED_STORAGE_KEYRING };
	}
	if (declared !== undefined || name === DEFAULT_PROFILE) {
		return locationForName(configDir, name);
	}
	return newProfileLocation(configDir, name, CRED_STORAGE_FILE);
};

const existingLocation = (
	configDir: string,
	name: string,
): CredentialLocation | null => {
	try {
		if (
			readProfiles(configDir)?.profiles[name] !== undefined ||
			name === DEFAULT_PROFILE
		) {
			return locationForName(configDir, name);
		}
	} catch {
		return null;
	}
	return null;
};

const warnIfKeyringRollbackUnconfirmed = (
	cleared: CredentialDeleteResult,
	profile: string,
): void => {
	if (cleared === "cleared") return;
	log.warning(
		'Could not confirm the new OS keyring item for profile "%s" was removed after a failed save.',
		profile,
	);
};

const deleteLeftoverOwnedFile = (
	configDir: string,
	path: string,
	except: string,
): void => {
	if (!isOwnedCredentialPath(configDir, path)) return;
	if (profilesUsingPath(configDir, path, except).length > 0) return;
	try {
		storeFor(configDir).delete({
			profile: except,
			storage: CRED_STORAGE_FILE,
			path,
		});
	} catch {
		log.warning("Saved the keyring item but could not delete %s", path);
	}
};

/** `--api-key -` means "read it from stdin", the usual convention for a piped value. */
const STDIN = "-";

/**
 * The key to store.
 *
 * Read from the *flag* and never from `NEON_API_KEY`. Everywhere else those are
 * interchangeable, but "store this credential permanently" is not something an exported
 * environment variable should be able to answer — a `create` that silently wrote whatever
 * happened to be in the shell would be storing a key the user never named.
 *
 * One flag, deliberately. Earlier revisions added `--api-key-file`, `--api-key-stdin` and
 * `--api-key-prompt` to keep the secret out of argv, which is four surfaces to document and
 * validate against each other for things the shell already does — `--api-key "$(cat file)"`
 * reads a file, `--api-key "$KEY"` takes a variable. Piping is the one case the shell cannot
 * express through an argument, so it gets the usual convention instead of a flag: `-`.
 */
const resolveKeyToStore = (props: CreateProps): string => {
	const fromFlag = credentialInputs().apiKeyFlag.trim();
	if (fromFlag === STDIN) return readKeyFromStdin();
	if (fromFlag !== "") return fromFlag;
	throw new Error(
		`Nothing to store for profile "${props.name}". Pass --api-key (or --api-key - to pipe it), --mint to have one minted, or no flags at all to sign in with the browser.`,
	);
};

/**
 * Read the key from stdin, for `--api-key -`.
 *
 * A terminal is refused rather than read: `readFileSync(0)` on a tty waits for EOF with no
 * prompt and nothing echoed, which is indistinguishable from a hang — and this spelling exists
 * for pipes, so a terminal means the pipe is missing.
 */
const readKeyFromStdin = (): string => {
	if (process.stdin.isTTY) {
		throw new Error(
			'`--api-key -` reads the key from stdin, but stdin is a terminal. Pipe it in: echo "$KEY" | neon profile create <name> --api-key -',
		);
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
	/** Where the key came from, so a rejection can say what to do about it. */
	origin: "supplied" | "minted" = "supplied",
): Promise<{
	label?: string;
	userId?: string;
	/** Set when the key belongs to an organization rather than a user. */
	orgId?: string;
	apiClient: NeonApiClient;
}> => {
	const apiClient = getApiClient({ apiKey, apiHost: props.apiHost });
	const { data: details } = await apiClient
		.getAuthDetails()
		.catch((err: unknown) => {
			// `profile` skips `ensureAuth`, so nothing recorded how this call authenticated and
			// the top-level handler falls back to "Check --api-key or NEON_API_KEY" — while
			// this command's own help says it ignores `NEON_API_KEY`. An agent reads that and
			// exports the variable to no effect.
			if (isNeonApiError(err) && err.status === 401) {
				throw new Error(
					origin === "minted"
						? "Neon rejected the key it had just minted. Nothing was stored; the key is being revoked."
						: "The Neon API rejected the key passed to --api-key. Check the value, or use --mint to have one minted for this profile.",
				);
			}
			throw err;
		});
	if (!isApiKeyMethod(details.auth_method)) {
		throw new Error(notAnApiKeyMessage(details.auth_method));
	}
	// Only a user key has a user to look up: `GET /users/me` answers 404 for an organization
	// key, so asking anyway would fail a `create` that is working perfectly.
	const email =
		details.auth_method === "api_key_user"
			? (await apiClient.getCurrentUserInfo()).data.email
			: undefined;
	return {
		...identityFromAuthDetails(details, email),
		...(details.auth_method === "api_key_org"
			? { orgId: details.account_id }
			: {}),
		apiClient,
	};
};

const create = async (props: CreateProps) => {
	const { name } = props;
	rejectProfileFlag(props, "create");
	assertValidProfileName(name);
	// Before the key is read from stdin, verified against the API, or minted in a browser.
	assertProfilesUsable(props.configDir, name);
	if (props.keyring === true) {
		storeFor(props.configDir).assertKeyringWritable(
			existingLocation(props.configDir, name)?.storage === "keyring"
				? name
				: undefined,
		);
	}

	const suppliedKey = credentialInputs().apiKeyFlag.trim() !== "";

	if (props.mint) {
		// Silently preferring one over the other would store a credential the user did not
		// choose — and the two disagree about which account the profile ends up as.
		if (suppliedKey) {
			throw new Error(
				"--mint creates a new key, so it cannot be combined with --api-key. Drop one.",
			);
		}
		await createByMinting(props);
		return;
	}

	if ((props.orgId ?? props.projectId) !== undefined) {
		throw new Error(
			"--org-id and --project-id only apply with --mint: they choose what a key we mint can reach, and a key you supply already has a scope.",
		);
	}

	// No key and no --mint means a browser sign-in, which is exactly `neon auth --profile`.
	// Delegating rather than reimplementing keeps one OAuth path in the CLI.
	if (!suppliedKey) {
		// The no-flag form is the one an agent reaches for first, and `authFlow` answers it
		// with a bare "Cannot run interactive auth in CI" — true, and no way forward. Say the
		// same thing `--mint` says, since the two ways out are the same.
		if (isCi() && props.forceAuth !== true) {
			throw new Error(
				`\`neon profile create ${name}\` with no key signs in through the browser, which cannot happen in CI. Pass a key instead: \`neon profile create ${name} --api-key "$KEY"\`, or pipe it with \`echo "$KEY" | neon profile create ${name} --api-key -\`.`,
			);
		}
		const at = locationForCreate(props.configDir, name, props.keyring);
		const existing = existingLocation(props.configDir, name);
		const previous =
			existing === null
				? null
				: readOutgoingCredential(props.configDir, existing);
		if (
			(await authFlow({
				...props,
				_: ["auth"],
				profile: name,
				keyring: props.keyring,
			})) === ""
		) {
			throw new Error(
				`Could not save credentials for profile "${name}".`,
			);
		}
		// authFlow retires keyring replacements; repeating it here would revoke the session twice.
		if (at.storage !== "keyring") {
			await retirePreviousCredential(props, name, previous);
		}
		const signedIn = readProfiles(props.configDir, log.warning)?.profiles[
			name
		];
		report(props, {
			name,
			account: signedIn?.label ?? signedIn?.userId ?? "unknown account",
			auth: "oauth",
			scope: "-",
			credentials:
				at.storage === "keyring" ? KEYRING_CREDENTIALS : at.path,
			storage: at.storage,
		});
		return;
	}

	const apiKey = resolveKeyToStore(props);
	const identity = await verifyKey(props, apiKey);
	const at = locationForCreate(props.configDir, name, props.keyring);
	const existing = existingLocation(props.configDir, name);
	if (at.storage === "keyring") {
		storeFor(props.configDir).assertKeyringWritable(
			existing?.storage === "keyring" ? name : undefined,
		);
	}
	const previous =
		existing === null
			? null
			: readOutgoingCredential(props.configDir, existing);

	storeFor(props.configDir).write(
		at,
		apiKeyCredentials({
			apiKey,
			...(identity.userId !== undefined
				? { userId: identity.userId }
				: {}),
			// A supplied organization key does not say which project it reaches, but the API
			// does say which organization — recording it keeps `list` from claiming "account",
			// and lets a later rotation refuse on the right grounds.
			...(identity.orgId !== undefined
				? { scope: { orgId: identity.orgId } }
				: {}),
		}),
	);
	try {
		recordProfile(props, name, at, identity);
	} catch (err) {
		if (at.storage === "keyring" && existing?.storage !== "keyring") {
			warnIfKeyringRollbackUnconfirmed(
				storeFor(props.configDir).delete(at, { required: false }),
				name,
			);
		}
		throw err instanceof Error ? err : new Error(String(err));
	}
	await retirePreviousCredential(props, name, previous, apiKey);
	if (at.storage === "keyring" && existing?.storage === "file") {
		deleteLeftoverOwnedFile(props.configDir, existing.path, name);
	}

	report(props, {
		name,
		account: identity.label ?? "unknown account",
		auth: "api key",
		scope: describeScope(
			identity.orgId !== undefined ? { orgId: identity.orgId } : {},
		),
		credentials: at.storage === "keyring" ? KEYRING_CREDENTIALS : at.path,
		storage: at.storage,
	});
	// A key we did not mint has no discoverable id: `GET /api_keys` exposes no prefix, so a
	// stored secret cannot be matched back to a listing entry. A warning rather than a note,
	// because it is the same caveat `api-keys create` raises at that level.
	log.warning(
		"A key you supplied cannot be revoked by `rotate-key` or `remove` — only keys minted here record an id.",
	);
};

/**
 * What a minted key can reach, in the same words `neon api-keys create` uses for the same key.
 *
 * Saying nothing here would be worse than there: this is the command aimed at agents and shared
 * machines, which is exactly where an over-broad credential does the most damage.
 */
const warnAboutReach = (scope: KeyScope): void => {
	if (scope.projectId !== undefined) {
		log.info(
			"Limited to %s: it cannot create projects, mint API keys, or read any other project. It can still change and delete everything inside that project.",
			scope.projectId,
		);
		return;
	}
	if (scope.orgId !== undefined) {
		log.warning(
			"This key reaches every project in %s, including ones created later. Pass --project-id instead to restrict it to one.",
			scope.orgId,
		);
		return;
	}
	log.warning(
		"This key reaches everything your account can, in every organization. Pass --org-id or --project-id to narrow it.",
	);
};

/**
 * Report a profile that was just written.
 *
 * Through the writer rather than `log`, so `--output json` yields the record an agent needs
 * instead of nothing — it had to follow up with `profile list` to learn what it just created.
 */
const report = (
	props: ProfileProps,
	record: {
		name: string;
		account: string;
		auth: string;
		scope: string;
		keyId?: number;
		credentials: string;
		storage?: string;
	},
): void => {
	const out = writer(props);
	if (props.output === "table") {
		log.info(
			'Profile "%s" now holds %s for %s (%s), in %s',
			record.name,
			record.auth,
			record.account,
			record.scope,
			record.credentials,
		);
		return;
	}
	out.end(record as never, {
		fields: [
			"name",
			"account",
			"auth",
			"scope",
			...(record.keyId !== undefined ? ["keyId"] : []),
			"credentials",
			...(record.storage !== undefined ? ["storage"] : []),
		] as never,
		title: "Profile",
	});
};

const recordProfile = (
	props: CreateProps,
	name: string,
	at: CredentialLocation,
	identity: { label?: string; userId?: string },
): void => {
	upsertProfile(props.configDir, name, {
		credentials: at.storage === "keyring" ? KEYRING_CREDENTIALS : at.path,
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
			`--mint needs a browser sign-in, which cannot happen in CI. Mint the key with \`neon api-keys create --name ${name}\` and pipe it in: echo "$KEY" | neon profile create ${name} --api-key -`,
		);
	}

	const atMint = locationForCreate(props.configDir, name, props.keyring);
	if (atMint.storage === "keyring") {
		storeFor(props.configDir).assertKeyringWritable(
			existingLocation(props.configDir, name)?.storage === "keyring"
				? name
				: undefined,
		);
	}

	const oauthProps = {
		oauthHost: props.oauthHost,
		clientId: props.clientId,
		...(props.allowUnsafeTls
			? { allowUnsafeTls: props.allowUnsafeTls }
			: {}),
	};

	// Sign in before anything else that needs an API call. `profile` commands skip
	// `ensureAuth`, so this invocation has no API client of its own — the session minted here
	// is the only credential available, and `--project-id` needs one to find the owning org.
	const tokenSet = await auth(oauthProps);
	const session = getApiClient({
		apiKey: tokenSet.access_token ?? "",
		apiHost: props.apiHost,
	});

	// Whatever happens after this point, the session was a means to an end. Revoking it in a
	// `finally` is what makes "stores only the key" true even when the command fails partway.
	let minted: { id: number; key: string; name: string } | undefined;
	// The scope actually minted at, not the flags: `--project-id` resolves an organization that
	// the revoke endpoint needs, and rebuilding it from flags would withdraw a project key
	// through the account endpoint and leave it live.
	let mintedScope: KeyScope = {};
	let keyIsReachable = false;
	try {
		const scope = await resolveMintScope(props, session);
		mintedScope = scope;
		minted = await mintKey(session, name, scope);
		const identity = await verifyKey(props, minted.key, "minted");
		const at = locationForCreate(props.configDir, name, props.keyring);
		const existing = existingLocation(props.configDir, name);
		const previous =
			existing === null
				? null
				: readOutgoingCredential(props.configDir, existing);

		storeFor(props.configDir).write(
			at,
			apiKeyCredentials({
				apiKey: minted.key,
				keyId: minted.id,
				...(identity.userId !== undefined
					? { userId: identity.userId }
					: {}),
				scope,
			}),
		);
		try {
			recordProfile(props, name, at, identity);
		} catch (err) {
			if (at.storage === "keyring" && existing?.storage !== "keyring") {
				warnIfKeyringRollbackUnconfirmed(
					storeFor(props.configDir).delete(at, { required: false }),
					name,
				);
			} else {
				keyIsReachable = true;
			}
			throw err instanceof Error ? err : new Error(String(err));
		}
		await retirePreviousCredential(props, name, previous, minted.key);
		if (at.storage === "keyring" && existing?.storage === "file") {
			deleteLeftoverOwnedFile(props.configDir, existing.path, name);
		}
		keyIsReachable = true;

		report(props, {
			name,
			account: identity.label ?? "unknown account",
			auth: "api key",
			scope: describeScope(scope),
			keyId: minted.id,
			credentials:
				at.storage === "keyring" ? KEYRING_CREDENTIALS : at.path,
			storage: at.storage,
		});
		warnAboutReach(scope);
	} finally {
		// A key minted but never written is unreachable, so it must not be left live.
		if (minted !== undefined && !keyIsReachable) {
			log.info(
				(await withdrawKey(session, mintedScope, minted.id))
					? `Revoked the key that was minted but not stored (id ${minted.id}).`
					: `Minted key ${minted.id} could be neither stored nor revoked, and may still be live. Remove it with: neon api-keys revoke ${minted.id}${mintedScope.orgId ? ` --org-id ${mintedScope.orgId}` : ""}`,
			);
		}
		const revoked = await revokeToken(oauthProps, tokenSet);
		log.info(
			revoked
				? "Signed the browser session back out, so nothing but the key remains."
				: "Could not sign the browser session back out; it will expire on its own.",
		);
	}
};

/**
 * The scope to mint at, resolving a project to the organization that owns it.
 *
 * A project-scoped key exists only on the organization endpoint, so the org has to be looked up
 * rather than asked for — `--project-id` alone would otherwise fail for a reason invisible from
 * the command line.
 */
const resolveMintScope = async (
	props: CreateProps,
	client: NeonApiClient,
): Promise<KeyScope> => {
	if (props.projectId === undefined) {
		return props.orgId !== undefined ? { orgId: props.orgId } : {};
	}
	// `api-keys create`'s lookup, not a second one. It already answers the mistake this flag
	// invites — an organization id typed into the project slot — and a local copy meant the
	// same typo got a written explanation there and a raw 404 here.
	return {
		orgId: await orgIdForProject(client, props.projectId),
		projectId: props.projectId,
	};
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

const rotateKey = async (props: ProfileProps & { name: string }) => {
	const { name } = props;
	rejectProfileFlag(props, "rotate-key");
	rejectApiKeyFlag(
		"rotate-key",
		`To store a key you already have, use \`neon profile create ${name} --api-key -\`.`,
	);
	// Resolve first: an unknown profile must fail having minted nothing.
	const profile = resolveProfile(props.configDir, name);

	const at = locationOf(profile);
	const credential = await usableCredential(props, at);
	if (credential === null) {
		throw new Error(
			`Profile "${name}" has no usable credential to mint with. Replace it with \`neon profile create ${name} --mint\`.`,
		);
	}
	// Rotating a *key* is what this command is for. An OAuth profile would otherwise be
	// converted into a key profile as a side effect, discarding a session it never revoked.
	if (credential.kind !== API_KEY) {
		throw new Error(
			`Profile "${name}" holds a browser sign-in, not an API key, so there is no key to rotate. Turn it into a key profile with \`neon profile create ${name} --mint\`.`,
		);
	}

	const stored = storeFor(props.configDir).read(at)?.credentials ?? null;
	const scope = stored !== null ? scopeOf(stored) : {};
	const previousKeyId =
		typeof stored?.key_id === "number" ? stored.key_id : undefined;

	const minting = getApiClient({
		apiKey: credential.apiKey,
		apiHost: props.apiHost,
	});
	// `profile` commands skip `ensureAuth`, so nothing has recorded how this call authenticated.
	// Without it a 401 here advises checking `--api-key` or `NEON_API_KEY`, neither of which the
	// user passed.
	setAuthContext({
		source: "profile-api-key",
		configDir: props.configDir,
		profile: name,
		storage: at.storage,
		...(at.storage === "file" ? { credentialsPath: at.path } : {}),
	});

	// Neon only lets a *personal* credential mint organization keys, so an organization key
	// cannot mint its own replacement. Asked of the credential itself rather than of the
	// recorded scope: a key that was supplied rather than minted has no scope on record, and
	// would otherwise sail past this and get "This endpoint requires a personal API key" from
	// a command where the user named nothing but a profile.
	const { data: details } = await minting.getAuthDetails();
	if (details.auth_method === "api_key_org") {
		// Only advise a scope we know. `api_key_org` covers organization *and* project keys, so
		// for a key we did not mint — which records no scope — suggesting `--org-id` could hand
		// the profile more reach than it had.
		const advice =
			scope.projectId !== undefined
				? `\`neon profile create ${name} --mint --project-id ${scope.projectId}\``
				: scope.orgId !== undefined && previousKeyId !== undefined
					? `\`neon profile create ${name} --mint --org-id ${scope.orgId}\``
					: `\`neon profile create ${name} --mint --org-id ${details.account_id}\` — but check \`neon api-keys list --org-id ${details.account_id}\` first, because a key you supplied may have been narrowed to a single project and an organization key would reach more`;
		throw new Error(
			`Profile "${name}" holds an organization key, and only a personal credential can mint organization keys — so it cannot mint its own replacement. Sign in and mint one with ${advice}.`,
		);
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
		storeFor(props.configDir).write(
			at,
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
			credentialLabel(at),
			created.id,
			scope.orgId ? ` --org-id ${scope.orgId}` : "",
		);
		throw err;
	}
	report(props, {
		name,
		account: profile.label ?? profile.userId ?? "unknown account",
		auth: "api key",
		scope: describeScope(scope),
		keyId: created.id,
		credentials: credentialsDisplay(profile),
		storage: at.storage,
	});

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
	rejectProfileFlag(props, "remove");
	rejectApiKeyFlag(
		"remove",
		"It revokes the credential stored for that profile, which is the only one it can revoke.",
	);
	// Resolve before touching anything: an unknown name must fail having deleted nothing.
	const profile = resolveProfile(props.configDir, name);

	if (!props.yes) {
		// Both halves, as every other prompt in the CLI checks. `isCi()` alone left the shape
		// a pipeline actually produces — stdin held by a pipe, `CI` unset — where `prompts`
		// draws a question nobody can answer: with stdin open it waits for input that never
		// comes, and at EOF it resolves to nothing, the event loop drains, and the process
		// exits 0 having removed nothing. Exiting 0 is the worse half: an agent reads success.
		if (isCi() || !process.stdin.isTTY) {
			throw new Error(
				"Refusing to remove a profile without confirmation when stdin is not a terminal. Pass --yes.",
			);
		}
		const who = profile.label ?? profile.userId ?? "unknown account";
		const { ok } = await prompts({
			type: "confirm",
			name: "ok",
			message: `Remove profile "${name}" (${who})?`,
			initial: false,
		});
		// Non-zero, because nothing was removed. A caller that scripts this reads the exit
		// code, and answering "no" is not the same outcome as removing the profile.
		if (!ok) {
			throw new Error(`Cancelled — profile "${name}" was not removed.`);
		}
	}

	// 1. Revoke upstream where we can, so the credential dies rather than merely becoming
	//    unreachable by us. Best-effort: a profile is often removed precisely because its
	//    access already broke.
	const at = locationOf(profile);
	let stored: OutgoingCredential | null = null;
	try {
		stored = readOutgoingCredential(props.configDir, at);
	} catch (err) {
		if (at.storage === "keyring") {
			log.warning(
				'Could not read the OS keyring item for profile "%s"; nothing in it could be revoked.',
				name,
			);
		} else {
			log.warning(
				"%s. Nothing in it could be revoked.",
				(err instanceof Error ? err.message : String(err)).replace(
					/\.$/,
					"",
				),
			);
		}
	}

	if (stored?.kind === API_KEY) {
		const { keyId, scope } = stored;
		if (keyId === undefined) {
			// A key we did not mint has no id we can match it by, so it outlives its profile.
			// Deleting the file quietly would imply the credential had been destroyed.
			log.warning(
				'Profile "%s" holds an API key that was supplied rather than minted here, so it stays live on the account — find it with `neon api-keys list`.',
				name,
			);
		} else {
			const client = getApiClient({
				apiKey: stored.apiKey,
				apiHost: props.apiHost,
			});
			log.info(
				(await withdrawKey(client, scope, keyId))
					? `Revoked the API key (id ${keyId})`
					: `Could not revoke the API key (id ${keyId}) — it may still be live. Remove it with: neon api-keys revoke ${keyId}${scope.orgId ? ` --org-id ${scope.orgId}` : ""}`,
			);
		}
	} else if (stored !== null) {
		const revoked = await revokeTokenSet(stored.tokens, props);
		log.info(
			revoked
				? "Revoked the OAuth token"
				: "Could not revoke the OAuth token — removing locally anyway",
		);
	}

	// Deleting the keyring item first could strand its pointer if the write fails.
	const dropPointer = (): void => {
		assertProfilesUsable(props.configDir, name);
		const path = profilesFilePath(props.configDir);
		const file = readProfiles(props.configDir, log.warning);
		if (file?.profiles[name]) {
			delete file.profiles[name];
			if (canDropProfilesFile(file)) {
				rmSync(path);
				log.info(
					'Removed "%s" — no profiles left, deleted %s',
					name,
					path,
				);
			} else {
				writeSecretFile(path, `${JSON.stringify(file, null, 2)}\n`);
				log.info('Removed "%s" from %s', name, path);
			}
		} else if (name === DEFAULT_PROFILE) {
			log.info("Signed out of DEFAULT");
		}
	};

	// Adopted files stay on disk because the CLI does not own them.
	const listing = storeFor(props.configDir).inspect(at);
	if (at.storage === "keyring") {
		// Removing the last profiles.json can change the directory used in the account hash.
		const account = keyringAccount(props.configDir, name);
		if (name === DEFAULT_PROFILE) {
			const leftover = credentialsPath(props.configDir);
			if (
				isOwnedCredentialPath(props.configDir, leftover) &&
				existsSync(leftover) &&
				profilesUsingPath(props.configDir, leftover, name).length === 0
			) {
				storeFor(props.configDir).delete(
					{
						profile: name,
						storage: CRED_STORAGE_FILE,
						path: leftover,
					},
					{ required: false },
				);
				if (existsSync(leftover)) {
					throw new Error(
						`Could not delete ${leftover}. Refusing to reset DEFAULT — that file would become the profile.`,
					);
				}
				log.info("Deleted %s", leftover);
			}
		}
		dropPointer();
		if (listing.reason?.includes("cannot use the OS keyring")) {
			log.warning(
				'This CLI cannot delete the OS keyring item for profile "%s". It remains in the OS store (service %s, account %s) until a CLI with the keyring addon removes it, or you delete it there.',
				name,
				KEYRING_SERVICE,
				account,
			);
			return;
		}
		let cleared: CredentialDeleteResult = "unconfirmed";
		try {
			cleared = storeFor(props.configDir).delete(at, {
				required: false,
				account,
			});
		} catch {
			cleared = "unconfirmed";
		}
		if (cleared === "cleared") {
			log.info('Deleted the OS keyring item for profile "%s"', name);
		} else {
			log.warning(
				'Could not confirm the OS keyring item for profile "%s" is gone. A leftover may still be in the OS store (service %s, account %s); it is not used once the profile is gone.',
				name,
				KEYRING_SERVICE,
				account,
			);
		}
		return;
	}

	if (isOwnedCredentialPath(props.configDir, at.path)) {
		storeFor(props.configDir).delete(at);
		if (listing.credentials !== null || listing.file !== "missing") {
			log.info("Deleted %s", at.path);
		}
	} else if (existsSync(at.path)) {
		log.info("Left %s on disk — not created by neon", at.path);
	}
	dropPointer();
};
