/**
 * Pointer-only profiles avoid mirrored credentials and persistent active-profile
 * state while preserving existing single-account and legacy-directory installs.
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

export const KEYRING_CREDENTIALS = "keyring";

export const isKeyringPointer = (credentials: string): boolean =>
	credentials === KEYRING_CREDENTIALS;

/** The implicit profile. Backed by plain `credentials.json`, with or without a profiles file. */
export const DEFAULT_PROFILE = "DEFAULT";

/** Profile names become part of a filename, so keep them boring. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ProfileEntry = {
	credentials: string;
	/** Account email, captured at login. Display only. */
	label?: string;
	/** Neon user id, captured at login. Display only. */
	userId?: string;
} & ProfileHosts;

/**
 * The Neon environment a named profile's credential was issued by. A staging credential sent
 * to production is rejected, so the profile has to carry its hosts rather than each command.
 * DEFAULT never has them: it follows `--api-host` / `NEON_API_HOST` as it always has.
 */
export type ProfileHosts = {
	/** Neon API base URL, as `--api-host` takes it. */
	apiHost?: string;
	/** Neon OAuth server, as `--oauth-host` takes it. */
	oauthHost?: string;
};

const HOST_FIELDS = ["apiHost", "oauthHost"] as const;

export const isHttpUrl = (value: string): boolean => {
	if (!URL.canParse(value)) return false;
	const { protocol } = new URL(value);
	return protocol === "https:" || protocol === "http:";
};

export const hostsOf = (entry: ProfileHosts): ProfileHosts => ({
	...(entry.apiHost !== undefined ? { apiHost: entry.apiHost } : {}),
	...(entry.oauthHost !== undefined ? { oauthHost: entry.oauthHost } : {}),
});

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
} & ProfileHosts;

export type ResolvedKeyringProfile = {
	name: string;
	storage: typeof CRED_STORAGE_KEYRING;
	label?: string;
	userId?: string;
	declared: boolean;
} & ProfileHosts;

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
		for (const field of HOST_FIELDS) {
			const value: unknown = entry[field];
			if (value === undefined) continue;
			if (name === DEFAULT_PROFILE) {
				return broken(
					`profile "${DEFAULT_PROFILE}" sets \`${field}\`, which only a named profile can. DEFAULT follows --api-host / --oauth-host and NEON_API_HOST / NEON_OAUTH_HOST`,
				);
			}
			if (typeof value !== "string" || !isHttpUrl(value)) {
				return broken(
					`profile "${name}" has an invalid \`${field}\`: expected an http or https URL`,
				);
			}
		}
	}
	return { kind: "ok", file: { version: 1, profiles } };
};

/**
 * Read `profiles.json`, or `null` when there is nothing usable there.
 *
 * A malformed file is reported through `onWarn` and treated as absent, because for a *read* the
 * worst case is a named profile turning up missing, which is recoverable — whereas throwing
 * would lock the user out of `neon login` itself. Writing is the opposite: see
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
 * Storage cannot be trusted when the profiles file cannot be read.
 *
 * Call this **before** anything that writes a credential, opens a browser, or spends an API
 * call. {@link upsertProfile} refuses too, but it runs last: by then `create` has already
 * overwritten `credentials.<name>.json` and revoked the key it replaced, and `neon login
 * --profile` has already signed in over it — a refusal that arrives after the destruction it
 * exists to prevent. The path resolution itself is the unsound part, since with the metadata
 * unreadable the conventional filename is a guess about which account that file belongs to.
 *
 * DEFAULT follows the same rule because the broken file may be its only
 * keyring pointer.
 */
export const assertProfilesUsable = (dir: string, name: string): void => {
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
	if (read.kind === "unusable") {
		throw new Error(
			`${read.reason}. Fix or delete the file — every profile is defined in it.`,
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
				...hostsOf(entry),
				declared: true,
			};
		}
		return {
			name,
			storage: CRED_STORAGE_FILE,
			credentialsPath: resolveEntryPath(dir, entry.credentials),
			...(entry.label ? { label: entry.label } : {}),
			...(entry.userId ? { userId: entry.userId } : {}),
			...hostsOf(entry),
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
	entry: {
		credentials: string;
		label?: string;
		userId?: string;
	} & HostUpdate,
): void => {
	assertValidProfileName(name);
	if (
		name === DEFAULT_PROFILE &&
		HOST_FIELDS.some((field) => typeof entry[field] === "string")
	) {
		throw new Error(
			`Profile "${DEFAULT_PROFILE}" cannot record an API or OAuth host. Create a named profile for another Neon environment.`,
		);
	}
	for (const field of HOST_FIELDS) {
		const value = entry[field];
		if (typeof value === "string" && !isHttpUrl(value)) {
			throw new Error(
				`Cannot record "${value}" as profile "${name}"'s ${field}: expected an http or https URL.`,
			);
		}
	}
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
							credentials: storedPointer(
								path,
								credentialsPath(dir),
							),
						},
					},
				};

	const previous = file.profiles[name];
	const host = (field: (typeof HOST_FIELDS)[number]) => {
		const value =
			entry[field] === undefined ? previous?.[field] : entry[field];
		return typeof value === "string" ? { [field]: value } : {};
	};
	file.profiles[name] = {
		credentials: storedPointer(path, entry.credentials),
		...(entry.label ? { label: entry.label } : {}),
		...(entry.userId ? { userId: entry.userId } : {}),
		...host("apiHost"),
		...host("oauthHost"),
	};

	writeProfiles(path, file);
};

/**
 * How {@link upsertProfile} treats a profile's hosts: a string sets one, `null` removes it, and
 * leaving it out keeps what the entry already had, so signing in again stays in the same
 * environment.
 */
export type HostUpdate = {
	apiHost?: string | null;
	oauthHost?: string | null;
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

/** A relative file named `keyring` would otherwise collide with the storage sentinel. */
const storedPointer = (profilesPath: string, credentials: string): string => {
	if (isKeyringPointer(credentials)) return KEYRING_CREDENTIALS;
	const base = resolve(profilesPath, "..");
	const abs = isAbsolute(credentials)
		? credentials
		: resolve(base, credentials);
	const rel = relative(base, abs);
	const stored = rel && !isAbsolute(rel) ? rel : abs;
	return stored === KEYRING_CREDENTIALS ? `./${KEYRING_CREDENTIALS}` : stored;
};

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
