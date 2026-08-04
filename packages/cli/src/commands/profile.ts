import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import prompts from "prompts";
import type yargs from "yargs";
import { credentialInputs } from "../_shared/auth_selection.js";
import {
	API_KEY,
	apiKeyCredentials,
	credentialKind,
	describeScope,
	inspectCredentials,
	isSameCredential,
	type KeyScope,
	readCredentials,
	type StoredCredentials,
	scopeOf,
	writeCredentials,
} from "../_shared/credentials.js";
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
} from "../_shared/profiles.js";
import { writeSecretFile } from "../_shared/secure_file.js";
import { getApiClient, type NeonApiClient } from "../api.js";
import { auth, revokeToken } from "../auth.js";
import { setAuthContext } from "../auth_context.js";
import { isInsideConfigDir } from "../config.js";
import { isCi } from "../env.js";
import { log } from "../log.js";
import {
	identityFromAuthDetails,
	isApiKeyMethod,
	mintedKeyName,
	notAnApiKeyMessage,
} from "../profile_keys.js";
import type { CommonProps, ExtendedTokenSet } from "../types.js";
import { noPassthrough, single } from "../utils/flags.js";
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
					.strict()
					.check(noPassthrough("profile create"))
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
 * Refuse `--profile` on a `profile` subcommand.
 *
 * These commands name their target as a positional, so `--profile` has nothing to select and
 * was silently dropped — which is precisely the class of bug this command family exists to
 * stop. `.strict()` cannot catch it because `--profile` is a global option.
 */
const rejectProfileFlag = (props: { profile?: string }, sub: string): void => {
	const named = props.profile?.trim();
	if (!named) return;
	throw new Error(
		`--profile does not apply to \`profile ${sub}\`, which takes the profile name as an argument. Did you mean \`neon profile ${sub} ${named}\`?`,
	);
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

/**
 * One row's view of a credentials file.
 *
 * Reports a damaged file as `invalid` and carries on, because one broken profile must not take
 * the whole listing with it — and unlike the authenticating path, listing has nothing to
 * recover, so the row itself is the report.
 */
const inspectForListing = (
	path: string,
): { stored: StoredCredentials | null; auth: string; file: string } => {
	const read = inspectCredentials(path);
	if (read.kind === "unusable") {
		log.warning(read.reason);
		return { stored: null, auth: "-", file: "invalid" };
	}
	if (read.kind === "absent")
		return { stored: null, auth: "-", file: "missing" };
	return {
		stored: read.credentials,
		auth: describeAuth(read.credentials, path),
		file: "ok",
	};
};

const list = async (props: ProfileProps) => {
	// `list` is the one subcommand where `--profile` means something: it marks the active row.
	// It still has to be a profile that exists, or the marker silently lands on nothing.
	const active = selectProfileName(props.profile);
	if (props.profile !== undefined && props.profile.trim() !== "") {
		resolveProfile(props.configDir, active);
	}
	const rows = listProfiles(props.configDir).map((p) => {
		const { stored, auth, file } = inspectForListing(p.credentialsPath);
		const storedUserId =
			typeof stored?.user_id === "string" ? stored.user_id : undefined;
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
			// Names what was actually checked. The column this replaced was called "available",
			// which claims the credential is ready to use — a thing reading a file cannot show,
			// and the wrong answer for the dead key someone runs this to diagnose.
			file,
			// The basename in the table, because `cli-table` neither wraps nor truncates and a
			// real path pushes the row past most terminals. Structured output keeps the path,
			// which is what a script actually wants.
			...(props.output === "table"
				? { credentials: basename(p.credentialsPath) }
				: { credentials: p.credentialsPath }),
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
			"file",
			"credentials",
		],
	});
};

/**
 * Where a profile's credentials belong: its existing file when it has one, `credentials.json`
 * for `DEFAULT`, and the conventional `credentials.<name>.json` for a profile being created.
 */
/**
 * The credential a command is about to replace or delete.
 *
 * Deliberately tolerant where {@link readCredentials} is fatal. Using a damaged credential must
 * fail loudly, but *replacing* one must not: `readCredentials` throwing here made the repair its
 * own error message recommends impossible, and left a malformed file unremovable through the
 * CLI. There is nothing to revoke in a file we cannot parse, so this says so and moves on.
 */
const readOutgoingCredential = (path: string): StoredCredentials | null => {
	const read = inspectCredentials(path);
	const unusable = (reason: string): null => {
		// `reason` comes from two sources, one of which ends in a period. Trim it so the
		// sentence does not run "…api_key".. Nothing in it…".
		log.warning(
			"%s. Nothing in it could be revoked, so it is only being replaced locally.",
			reason.replace(/\.$/, ""),
		);
		return null;
	};

	if (read.kind === "unusable") return unusable(read.reason);
	if (read.kind === "absent") return null;

	// A declared kind we do not recognise is the same situation as unparseable: there is
	// nothing here we know how to revoke, and refusing would make the file undeletable.
	try {
		credentialKind(read.credentials, path);
	} catch (err) {
		return unusable(err instanceof Error ? err.message : String(err));
	}
	return read.credentials;
};

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
	if (!declared && !(name === DEFAULT_PROFILE && existsSync(path))) return;

	// Only offer `rotate-key` when it would actually work: it refuses anything that is not
	// already an API-key profile, and `DEFAULT` is an OAuth profile on nearly every install.
	const existing = inspectCredentials(path);
	const rotatable =
		existing.kind === "ok" &&
		credentialKind(existing.credentials, path) === API_KEY;
	throw new Error(
		rotatable
			? `Profile "${name}" already exists. Pass --force to replace its credential, or \`neon profile rotate-key ${name}\` to mint a fresh key for it.`
			: `Profile "${name}" already exists. Pass --force to replace its credential.`,
	);
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
): Promise<{
	label?: string;
	userId?: string;
	/** Set when the key belongs to an organization rather than a user. */
	orgId?: string;
	apiClient: NeonApiClient;
}> => {
	const apiClient = getApiClient({ apiKey, apiHost: props.apiHost });
	const { data: details } = await apiClient.getAuthDetails();
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
	assertReplaceable(props);

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
		const credentialsPath = credentialsPathFor(props.configDir, name);
		const previous = readOutgoingCredential(credentialsPath);
		// `authFlow` reports its own failure and returns an empty token rather than throwing,
		// so claiming success here would leave the user with no profile and no error.
		if ((await authFlow({ ...props, _: ["auth"], profile: name })) === "") {
			throw new Error(
				`Could not save credentials for profile "${name}".`,
			);
		}
		await retirePreviousCredential(props, name, previous, credentialsPath);
		const signedIn = readProfiles(props.configDir, log.warning)?.profiles[
			name
		];
		report(props, {
			name,
			account: signedIn?.label ?? signedIn?.userId ?? "unknown account",
			auth: "oauth",
			scope: "-",
			credentials: credentialsPath,
		});
		return;
	}

	const apiKey = resolveKeyToStore(props);
	const identity = await verifyKey(props, apiKey);
	const credentialsPath = credentialsPathFor(props.configDir, name);
	const previous = readOutgoingCredential(credentialsPath);

	writeCredentials(
		credentialsPath,
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
	await retirePreviousCredential(
		props,
		name,
		previous,
		credentialsPath,
		apiKey,
	);
	recordProfile(props, name, credentialsPath, identity);

	report(props, {
		name,
		account: identity.label ?? "unknown account",
		auth: "api key",
		scope: describeScope(
			identity.orgId !== undefined ? { orgId: identity.orgId } : {},
		),
		credentials: credentialsPath,
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
		] as never,
		title: "Profile",
	});
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
			`--mint needs a browser sign-in, which cannot happen in CI. Mint the key with \`neon api-keys create --name ${name}\` and pipe it in: echo "$KEY" | neon profile create ${name} --api-key -`,
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
		const identity = await verifyKey(props, minted.key);
		const credentialsPath = credentialsPathFor(props.configDir, name);
		const previous = readOutgoingCredential(credentialsPath);

		writeCredentials(
			credentialsPath,
			apiKeyCredentials({
				apiKey: minted.key,
				keyId: minted.id,
				...(identity.userId !== undefined
					? { userId: identity.userId }
					: {}),
				scope,
			}),
		);
		// From here the key is on disk and usable, so cleanup must not take it away — a
		// failure writing `profiles.json` costs a profile entry, not the credential.
		keyIsReachable = true;

		await retirePreviousCredential(
			props,
			name,
			previous,
			credentialsPath,
			minted.key,
		);
		recordProfile(props, name, credentialsPath, identity);

		report(props, {
			name,
			account: identity.label ?? "unknown account",
			auth: "api key",
			scope: describeScope(scope),
			keyId: minted.id,
			credentials: credentialsPath,
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
	const {
		data: { project },
	} = await client.getProject(props.projectId);
	if (!project.org_id) {
		throw new Error(
			`Project ${props.projectId} does not belong to an organization, so it cannot have a project-scoped API key. Omit --project-id, or pass --org-id.`,
		);
	}
	return { orgId: project.org_id, projectId: props.projectId };
};

/**
 * Revoke a credential a profile has just stopped using.
 *
 * Called with the credential read *before* the overwrite, and only *after* the replacement is
 * durable. Both halves matter. Reading it first is the only chance: a minted key's `key_id` and
 * an OAuth refresh token are gone the moment the file is rewritten, so nothing could revoke
 * them afterwards. Revoking last is what stops a cancelled sign-in or a failed write from
 * leaving the profile holding a credential that has already been killed.
 */
const retirePreviousCredential = async (
	props: ProfileProps,
	name: string,
	existing: StoredCredentials | null,
	credentialsPath: string,
	/** The key now stored. Retiring this would kill the credential we just committed to. */
	replacementKey?: string,
): Promise<void> => {
	if (existing === null) return;

	// Re-storing the key a profile already holds is a no-op, not a replacement. Revoking here
	// would leave the profile pointing at a credential this command had just killed.
	if (isSameCredential(existing, replacementKey)) {
		log.debug(
			"The replacement is the credential already stored; nothing to retire.",
		);
		return;
	}

	// Already classified by `readOutgoingCredential`, which is the only way a credential
	// reaches here.
	if (credentialKind(existing, credentialsPath) === API_KEY) {
		const keyId =
			typeof existing.key_id === "number" ? existing.key_id : undefined;
		if (keyId === undefined) {
			log.warning(
				'Profile "%s" held an API key that was supplied rather than minted here, so it stays live on the account — find it with `neon api-keys list`.',
				name,
			);
			return;
		}
		const client = getApiClient({
			apiKey: existing.api_key as string,
			apiHost: props.apiHost,
		});
		log.info(
			(await withdrawKey(client, scopeOf(existing), keyId))
				? `Revoked the key it replaces (id ${keyId})`
				: `Could not revoke the key it replaces (id ${keyId}); it may still be live. Remove it with: neon api-keys revoke ${keyId}`,
		);
		return;
	}

	const revoked = await revokeTokenSet(existing, props);
	log.info(
		revoked
			? "Signed out the session it replaced"
			: "Could not sign out the session it replaced; it will expire on its own",
	);
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
	rejectProfileFlag(props, "rotate-key");
	// Resolve first: an unknown profile must fail having minted nothing.
	const profile = resolveProfile(props.configDir, name);

	const credential = await usableCredential(props, profile.credentialsPath);
	if (credential === null) {
		throw new Error(
			`Profile "${name}" has no usable credential to mint with. Replace it with \`neon profile create ${name} --mint --force\`.`,
		);
	}
	// Rotating a *key* is what this command is for. An OAuth profile would otherwise be
	// converted into a key profile as a side effect, discarding a session it never revoked.
	if (credential.kind !== API_KEY) {
		throw new Error(
			`Profile "${name}" holds a browser sign-in, not an API key, so there is no key to rotate. Turn it into a key profile with \`neon profile create ${name} --mint --force\`.`,
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
	// `profile` commands skip `ensureAuth`, so nothing has recorded how this call authenticated.
	// Without it a 401 here advises checking `--api-key` or `NEON_API_KEY`, neither of which the
	// user passed.
	setAuthContext({
		source: "profile-api-key",
		configDir: props.configDir,
		profile: name,
		credentialsPath: profile.credentialsPath,
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
				? `\`neon profile create ${name} --mint --project-id ${scope.projectId} --force\``
				: scope.orgId !== undefined && previousKeyId !== undefined
					? `\`neon profile create ${name} --mint --org-id ${scope.orgId} --force\``
					: `\`neon profile create ${name} --mint --org-id ${details.account_id} --force\` — but check \`neon api-keys list --org-id ${details.account_id}\` first, because a key you supplied may have been narrowed to a single project and an organization key would reach more`;
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
	report(props, {
		name,
		account: profile.label ?? profile.userId ?? "unknown account",
		auth: "api key",
		scope: describeScope(scope),
		keyId: created.id,
		credentials: profile.credentialsPath,
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
	const stored = readOutgoingCredential(profile.credentialsPath);
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
	} else if (stored !== null) {
		const revoked = await revokeTokenSet(stored, props);
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
	const file = readProfiles(props.configDir, log.warning);
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

/** Revoke the OAuth refresh token in a credential we already have in hand. */
const revokeTokenSet = async (
	credentials: StoredCredentials,
	props: ProfileProps,
): Promise<boolean> => {
	const tokenSet = credentials as unknown as ExtendedTokenSet;
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
