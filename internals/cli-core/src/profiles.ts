/**
 * # Profiles — several Neon accounts in one config directory
 *
 * A profile is **a pointer**: a credentials file path, or the sentinel `"keyring"`. That
 * constraint is what keeps the feature small: there is no mirror, no per-profile directory
 * tree, no persistent "active profile" state to fall out of sync, and no migration.
 *
 * ```
 * ~/.config/neon/
 * ├── credentials.json          # this IS the DEFAULT profile, not a copy of it
 * ├── credentials.work.json     # created by `neon auth --profile work`
 * └── profiles.json             # created once a second profile exists, or DEFAULT is keyring
 * ```
 *
 * `profiles.json` maps a name to a pointer: a credentials file path, or the sentinel
 * `"keyring"`. The path may point anywhere — which is what makes adopting an existing
 * directory a one-line edit rather than an import command:
 *
 * ```json
 * {
 *   "version": 1,
 *   "profiles": {
 *     "DEFAULT": { "credentials": "keyring" },
 *     "work": {
 *       "credentials": "../neonctl-databricks/credentials.json",
 *       "label": "someone@example.com"
 *     }
 *   }
 * }
 * ```
 *
 * ## Selection
 *
 * `--profile` → `NEON_PROFILE` → `DEFAULT`. Per invocation, like `AWS_PROFILE`; there is no
 * `profile use` command, so nothing persists that could disagree with what you typed.
 *
 * ## Compatibility
 *
 * An install with no `profiles.json` is already a valid `DEFAULT`-only state: `DEFAULT`
 * resolves to `credentials.json` in the config directory (including an existing one in the
 * legacy `neonctl` directory — see `./paths.ts`). Nothing is created until a second
 * profile is, and nothing is ever moved.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
	CRED_STORAGE_FILE,
	CRED_STORAGE_KEYRING,
	type CredStorage,
} from "./cli_config.js";
import type { CredentialLocation } from "./credentials.js";
import { credentialsPath, defaultDir, resolveConfigFile } from "./paths.js";
import { writeSecretFile } from "./secure_file.js";

export const PROFILES_FILE = "profiles.json";

/** Sentinel stored in `profiles.json` `credentials` when the secret is in the OS keyring. */
export const KEYRING_CREDENTIALS = "keyring";

export const isKeyringPointer = (credentials: string): boolean =>
	credentials === KEYRING_CREDENTIALS;

/** The implicit profile. Backed by plain `credentials.json`, with or without a profiles file. */
export const DEFAULT_PROFILE = "DEFAULT";

/** Profile names become part of a filename, so keep them boring. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ProfileEntry = {
	/** Path to the credentials file, or `"keyring"`. */
	credentials: string;
	/** Account email, captured at login. Display only. */
	label?: string;
	/** Neon user id, captured at login. Display only. */
	userId?: string;
};

export type ProfilesFile = {
	version: 1;
	profiles: Record<string, ProfileEntry>;
};

export type ResolvedFileProfile = {
	name: string;
	storage: typeof CRED_STORAGE_FILE;
	/** Absolute path to this profile's credentials file. */
	credentialsPath: string;
	label?: string;
	userId?: string;
	/** True when the profile comes from `profiles.json` rather than the implicit default. */
	declared: boolean;
};

export type ResolvedKeyringProfile = {
	name: string;
	storage: typeof CRED_STORAGE_KEYRING;
	label?: string;
	userId?: string;
	declared: boolean;
};

export type ResolvedProfile = ResolvedFileProfile | ResolvedKeyringProfile;

export const locationOf = (profile: ResolvedProfile): CredentialLocation =>
	profile.storage === CRED_STORAGE_KEYRING
		? { profile: profile.name, storage: CRED_STORAGE_KEYRING }
		: {
				profile: profile.name,
				storage: CRED_STORAGE_FILE,
				path: profile.credentialsPath,
			};

export const credentialsDisplay = (profile: ResolvedProfile): string =>
	profile.storage === CRED_STORAGE_KEYRING
		? KEYRING_CREDENTIALS
		: profile.credentialsPath;

/** Which profile this invocation should use: `--profile` → `NEON_PROFILE` → `DEFAULT`. */
export const selectProfileName = (
	flag?: string,
	env: NodeJS.ProcessEnv = process.env,
): string => nonEmpty(flag) ?? nonEmpty(env.NEON_PROFILE) ?? DEFAULT_PROFILE;

export const assertValidProfileName = (name: string): void => {
	if (!NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid profile name "${name}". Use letters, digits, dot, dash or underscore, starting with a letter or digit.`,
		);
	}
};

/** Where `profiles.json` lives for this config directory (whether or not it exists yet). */
export const profilesFilePath = (dir: string): string =>
	resolveConfigFile(PROFILES_FILE, dir === defaultDir ? {} : { dir }).path;

/** What is at `profiles.json`: nothing, something readable, or something broken. */
export type ProfilesRead =
	| { kind: "ok"; file: ProfilesFile }
	| { kind: "absent" }
	/** The file is there and cannot be trusted. `reason` names the file and is safe to print. */
	| { kind: "unusable"; reason: string };

/**
 * Read and classify `profiles.json` without deciding what to do about it.
 *
 * Entry keys and shapes are validated here rather than at each use. A key is a profile name,
 * and a name that `assertValidProfileName` would reject cannot have been written by this CLI —
 * it would travel into error messages as a recovery command nobody can run, and into a
 * `credentials.<name>.json` filename.
 */
export const inspectProfiles = (dir: string): ProfilesRead => {
	const path = profilesFilePath(dir);
	if (!existsSync(path)) return { kind: "absent" };
	const broken = (why: string): ProfilesRead => ({
		kind: "unusable",
		reason: `${path} could not be read as a profiles file: ${why}`,
	});
	// Reading and parsing are separate failures with separate answers. Sharing one catch
	// reported `EACCES` as "not valid JSON", which sends the user to edit a file that is
	// perfectly valid and that they cannot open.
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return broken(
			code ? `reading it failed with ${code}` : "reading it failed",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		return broken("it is not valid JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return broken("it does not contain an object");
	const profiles = (parsed as ProfilesFile).profiles;
	if (
		profiles === null ||
		typeof profiles !== "object" ||
		Array.isArray(profiles)
	)
		return broken("it has no `profiles` object");
	for (const [name, entry] of Object.entries(profiles)) {
		if (!NAME_PATTERN.test(name))
			return broken(`"${name}" is not a valid profile name`);
		if (
			entry === null ||
			typeof entry !== "object" ||
			typeof entry.credentials !== "string" ||
			entry.credentials.trim() === ""
		) {
			return broken(`profile "${name}" has no \`credentials\` pointer`);
		}
	}
	return { kind: "ok", file: { version: 1, profiles } };
};

/**
 * Read `profiles.json`, or `null` when there is nothing usable there.
 *
 * A malformed file is reported through `onWarn` and treated as absent, because for a *read* the
 * worst case is a named profile turning up missing, which is recoverable — whereas throwing
 * would lock the user out of `neon auth` itself. Writing is the opposite: see
 * {@link upsertProfile}, which refuses rather than rebuilding a file it cannot read.
 */
export const readProfiles = (
	dir: string,
	/** Called with the reason a profiles file was ignored. The consumer owns how it reports. */
	onWarn: (message: string) => void = () => {},
): ProfilesFile | null => {
	const read = inspectProfiles(dir);
	if (read.kind === "ok") return read.file;
	if (read.kind === "unusable") onWarn(read.reason);
	return null;
};

/**
 * Refuse to act on a named profile when the file that defines it cannot be read.
 *
 * Call this **before** anything that writes a credential, opens a browser, or spends an API
 * call. {@link upsertProfile} refuses too, but it runs last: by then `create` has already
 * overwritten `credentials.<name>.json` and revoked the key it replaced, and `neon auth
 * --profile` has already signed in over it — a refusal that arrives after the destruction it
 * exists to prevent. The path resolution itself is the unsound part, since with the metadata
 * unreadable the conventional filename is a guess about which account that file belongs to.
 *
 * `DEFAULT` is exempt: it is defined by the absence of metadata rather than by an entry, so
 * signing in normally must keep working while a broken `profiles.json` is repaired.
 */
export const assertProfilesUsable = (dir: string, name: string): void => {
	if (name === DEFAULT_PROFILE) return;
	const read = inspectProfiles(dir);
	if (read.kind === "unusable") {
		throw new Error(
			`${read.reason}. Fix or delete the file before working with profile "${name}" — it is the only record of where each account's credentials live.`,
		);
	}
};

/** Resolve a profile to an absolute credentials path. Throws when a named profile is unknown. */
export const resolveProfile = (dir: string, name: string): ResolvedProfile => {
	const read = inspectProfiles(dir);
	// A broken file must not be reported as `Unknown profile "work"`. That names the wrong
	// problem, and the user goes looking for a profile they can see in the file in front of them.
	if (read.kind === "unusable" && name !== DEFAULT_PROFILE) {
		throw new Error(
			`${read.reason}. Fix or delete the file — every named profile is defined in it.`,
		);
	}
	const file = read.kind === "ok" ? read.file : null;
	const entry = file?.profiles[name];

	if (entry) {
		if (isKeyringPointer(entry.credentials)) {
			return {
				name,
				storage: CRED_STORAGE_KEYRING,
				...(entry.label ? { label: entry.label } : {}),
				...(entry.userId ? { userId: entry.userId } : {}),
				declared: true,
			};
		}
		return {
			name,
			storage: CRED_STORAGE_FILE,
			credentialsPath: resolveEntryPath(dir, entry.credentials),
			...(entry.label ? { label: entry.label } : {}),
			...(entry.userId ? { userId: entry.userId } : {}),
			declared: true,
		};
	}

	// DEFAULT works with no profiles.json at all, and keeps working when one exists but
	// doesn't mention it — that is the pre-profiles behaviour, unchanged.
	if (name === DEFAULT_PROFILE) {
		return {
			name,
			storage: CRED_STORAGE_FILE,
			credentialsPath: credentialsPath(dir),
			declared: false,
		};
	}

	const known = file
		? Object.keys(file.profiles).join(", ")
		: DEFAULT_PROFILE;
	throw new Error(
		`Unknown profile "${name}". Known profiles: ${known}. Create it with \`neon profile create ${name}\`.`,
	);
};

/** Default location for a new named profile's credentials file. */
export const newProfileCredentialsPath = (dir: string, name: string): string =>
	resolve(dir, `credentials.${name}.json`);

/**
 * Record a profile, creating `profiles.json` if this is the first named one.
 *
 * When the file is created, `DEFAULT` is written explicitly and pointed at wherever
 * `credentials.json` actually is. That matters for an install predating the directory
 * rename: `profiles.json` is created in `neon/` while the credentials are still in
 * `neonctl/`, so `DEFAULT` is recorded as `../neonctl/credentials.json` rather than a
 * relative name that would resolve to a file that isn't there.
 */
export const upsertProfile = (
	dir: string,
	name: string,
	entry: { credentials: string; label?: string; userId?: string },
): void => {
	assertValidProfileName(name);
	const path = profilesFilePath(dir);
	const read = inspectProfiles(dir);
	// Refusing is the point. Treating a broken file as absent here rebuilt it from a single
	// `DEFAULT` entry and dropped every named profile in it — silent data loss, in the file
	// that is the only record of where each account's credentials live. The credentials
	// themselves survive, so fixing the file by hand recovers everything.
	if (read.kind === "unusable") {
		throw new Error(
			`${read.reason}. Refusing to rewrite it, because doing so would discard the profiles it defines. Fix or delete the file, then re-run.`,
		);
	}
	const file =
		read.kind === "ok"
			? read.file
			: {
					version: 1 as const,
					profiles: {
						[DEFAULT_PROFILE]: {
							credentials: relativeToProfiles(
								path,
								credentialsPath(dir),
							),
						},
					},
				};

	file.profiles[name] = {
		credentials: isKeyringPointer(entry.credentials)
			? KEYRING_CREDENTIALS
			: relativeToProfiles(path, entry.credentials),
		...(entry.label ? { label: entry.label } : {}),
		...(entry.userId ? { userId: entry.userId } : {}),
	};

	writeProfiles(path, file);
};

/** Update the pointer, keeping any label / userId already recorded. */
export const setProfilePointer = (
	dir: string,
	name: string,
	credentials: string,
): void => {
	const read = inspectProfiles(dir);
	const prev = read.kind === "ok" ? read.file.profiles[name] : undefined;
	upsertProfile(dir, name, {
		credentials,
		...(prev?.label ? { label: prev.label } : {}),
		...(prev?.userId ? { userId: prev.userId } : {}),
	});
};

/** Remove an entry. Returns false when it wasn't there. */
export const removeProfileEntry = (dir: string, name: string): boolean => {
	const path = profilesFilePath(dir);
	const file = readProfiles(dir);
	if (!file?.profiles[name]) return false;
	delete file.profiles[name];
	writeProfiles(path, file);
	return true;
};

/**
 * True when only `DEFAULT` is left, so `profiles.json` no longer earns its place. Mirrors
 * lazy creation: a single-account install has no profiles file, before or after.
 *
 * A keyring DEFAULT still needs the file — that entry is the only record that the
 * secret is not in `credentials.json`.
 */
export const onlyDefaultRemains = (file: ProfilesFile): boolean => {
	const names = Object.keys(file.profiles);
	return (
		names.length === 0 ||
		(names.length === 1 && names[0] === DEFAULT_PROFILE)
	);
};

export const canDropProfilesFile = (file: ProfilesFile): boolean => {
	if (!onlyDefaultRemains(file)) return false;
	const remaining = file.profiles[DEFAULT_PROFILE];
	return remaining === undefined || !isKeyringPointer(remaining.credentials);
};

export const locationForName = (
	dir: string,
	name: string,
): CredentialLocation => locationOf(resolveProfile(dir, name));

export const newProfileLocation = (
	dir: string,
	name: string,
	storage: CredStorage,
): CredentialLocation =>
	storage === CRED_STORAGE_KEYRING
		? { profile: name, storage: CRED_STORAGE_KEYRING }
		: {
				profile: name,
				storage: CRED_STORAGE_FILE,
				path: newProfileCredentialsPath(dir, name),
			};

/** Other declared profiles whose pointer resolves to this file. */
export const profilesUsingPath = (
	dir: string,
	path: string,
	except?: string,
): string[] => {
	const resolved = resolve(path);
	return listProfiles(dir)
		.filter(
			(profile) =>
				profile.name !== except &&
				profile.storage === CRED_STORAGE_FILE &&
				resolve(profile.credentialsPath) === resolved,
		)
		.map((profile) => profile.name);
};

export const listProfiles = (dir: string): ResolvedProfile[] => {
	const read = inspectProfiles(dir);
	// Listing is the command run to find out what is there, so a broken file is the answer
	// rather than an obstacle. Showing only `DEFAULT` would state, as fact, that the profiles
	// in that file do not exist.
	if (read.kind === "unusable") {
		throw new Error(
			`${read.reason}. Fix or delete the file — every named profile is defined in it.`,
		);
	}
	const file = read.kind === "ok" ? read.file : null;
	if (!file) return [resolveProfile(dir, DEFAULT_PROFILE)];
	const names = Object.keys(file.profiles);
	if (!names.includes(DEFAULT_PROFILE)) names.unshift(DEFAULT_PROFILE);
	return names.map((name) => resolveProfile(dir, name));
};

const writeProfiles = (path: string, file: ProfilesFile): void => {
	writeSecretFile(path, `${JSON.stringify(file, null, 2)}\n`);
};

const resolveEntryPath = (dir: string, entry: string): string =>
	isAbsolute(entry) ? entry : resolve(profilesDir(dir), entry);

/** `profiles.json` may sit in the legacy directory, so entries resolve against its own dir. */
const profilesDir = (dir: string): string =>
	resolve(profilesFilePath(dir), "..");

/** Keep entries relative when they sit near `profiles.json`; absolute paths stay absolute. */
const relativeToProfiles = (profilesPath: string, target: string): string => {
	const rel = relative(resolve(profilesPath, ".."), target);
	return rel && !isAbsolute(rel) ? rel : target;
};

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
