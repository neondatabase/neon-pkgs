/**
 * # Profiles — several Neon accounts in one config directory
 *
 * A profile is **a pointer to a credentials file**. Nothing more. That constraint is what
 * keeps the feature small: there is no mirror, no per-profile directory tree, no persistent
 * "active profile" state to fall out of sync, and no migration.
 *
 * ```
 * ~/.config/neon/
 * ├── credentials.json          # this IS the DEFAULT profile, not a copy of it
 * ├── credentials.work.json     # created by `neon auth --profile work`
 * └── profiles.json             # created only once a second profile exists
 * ```
 *
 * `profiles.json` maps a name to a path, and the path may point anywhere — which is what
 * makes adopting an existing directory a one-line edit rather than an import command:
 *
 * ```json
 * {
 *   "version": 1,
 *   "profiles": {
 *     "DEFAULT": { "credentials": "credentials.json" },
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
 * legacy `neonctl` directory — see `@neon/config/paths`). Nothing is created until a second
 * profile is, and nothing is ever moved.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { resolveConfigFile } from "@neon/config/paths";
import { credentialsPath, defaultDir } from "./config.js";
import { log } from "./log.js";
import { writeSecretFile } from "./utils/secure_file.js";

export const PROFILES_FILE = "profiles.json";

/** The implicit profile. Backed by plain `credentials.json`, with or without a profiles file. */
export const DEFAULT_PROFILE = "DEFAULT";

/** Profile names become part of a filename, so keep them boring. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ProfileEntry = {
	/** Path to the credentials file, relative to `profiles.json` or absolute. */
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

export type ResolvedProfile = {
	name: string;
	/** Absolute path to this profile's credentials file. */
	credentialsPath: string;
	label?: string;
	userId?: string;
	/** True when the profile comes from `profiles.json` rather than the implicit default. */
	declared: boolean;
};

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

/**
 * Read `profiles.json`, or `null` when there isn't one — the normal single-account state.
 * A malformed file is reported and treated as absent rather than breaking every command;
 * the worst case is that a named profile is "not found", which is recoverable, whereas
 * throwing here would lock the user out of `neon auth` itself.
 */
export const readProfiles = (dir: string): ProfilesFile | null => {
	const path = profilesFilePath(dir);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		)
			throw new Error("not an object");
		const profiles = (parsed as ProfilesFile).profiles;
		if (
			profiles === null ||
			typeof profiles !== "object" ||
			Array.isArray(profiles)
		)
			throw new Error("missing `profiles`");
		return { version: 1, profiles };
	} catch (err) {
		log.warning(
			"Ignoring malformed %s: %s",
			path,
			err instanceof Error ? err.message : String(err),
		);
		return null;
	}
};

/** Resolve a profile to an absolute credentials path. Throws when a named profile is unknown. */
export const resolveProfile = (dir: string, name: string): ResolvedProfile => {
	const file = readProfiles(dir);
	const entry = file?.profiles[name];

	if (entry) {
		return {
			name,
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
			credentialsPath: credentialsPath(dir),
			declared: false,
		};
	}

	const known = file
		? Object.keys(file.profiles).join(", ")
		: DEFAULT_PROFILE;
	throw new Error(
		`Unknown profile "${name}". Known profiles: ${known}. Create it with \`neon auth --profile ${name}\`.`,
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
	const file = readProfiles(dir) ?? {
		version: 1 as const,
		profiles: {
			[DEFAULT_PROFILE]: {
				credentials: relativeToProfiles(path, credentialsPath(dir)),
			},
		},
	};

	file.profiles[name] = {
		credentials: relativeToProfiles(path, entry.credentials),
		...(entry.label ? { label: entry.label } : {}),
		...(entry.userId ? { userId: entry.userId } : {}),
	};

	writeProfiles(path, file);
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
 */
export const onlyDefaultRemains = (file: ProfilesFile): boolean => {
	const names = Object.keys(file.profiles);
	return (
		names.length === 0 ||
		(names.length === 1 && names[0] === DEFAULT_PROFILE)
	);
};

export const listProfiles = (dir: string): ResolvedProfile[] => {
	const file = readProfiles(dir);
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
