/**
 * # Which Neon API and OAuth hosts an invocation talks to
 *
 * Per host, each entry winning over the next:
 *
 * 1. `--api-host` / `--oauth-host`.
 * 2. The host recorded on the named profile whose credential this invocation uses.
 * 3. `NEON_API_HOST` / `NEON_OAUTH_HOST`.
 * 4. Production.
 *
 * A recorded host outranks the environment variable for the reason `--profile` outranks
 * `NEON_API_KEY`: the profile's credential is valid only on the environment that issued it, so an
 * exported host must not send it somewhere else. Only a flag typed for this one command does.
 *
 * Hosts are recorded only from those flags, on `neon login --profile <name>` and `neon profile
 * create <name>`. The environment variables are never written down, so exporting one keeps
 * meaning "this shell", as it did before profiles could hold hosts.
 *
 * The arguments are read before yargs runs, because the staging gate decides which commands to
 * register from the host, and the result becomes the yargs default so every handler receives it.
 */

import {
	type SelectionInput,
	selectCredential,
} from "@neon-internals/cli-core/auth_selection";
import { defaultDir } from "@neon-internals/cli-core/paths";
import {
	DEFAULT_PROFILE,
	type HostUpdate,
	hostsOf,
	inspectProfiles,
	isHttpUrl,
	type ProfileHosts,
} from "@neon-internals/cli-core/profiles";
import { hideBin, Parser } from "yargs/helpers";
import { DEFAULT_API_HOST } from "./api.js";

export const DEFAULT_OAUTH_HOST = "https://oauth2.neon.tech";

export type Hosts = { apiHost: string; oauthHost: string };

type Invocation = {
	/** The host flags as typed. */
	flags: ProfileHosts;
	configDir: string;
	/** The profile whose credential `ensureAuth` will use, or none when it uses an API key. */
	profile: string | undefined;
};

const lastString = (value: unknown): string | undefined => {
	const last = Array.isArray(value) ? value.at(-1) : value;
	return typeof last === "string" ? last : undefined;
};

const parseInvocation = (
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): Invocation => {
	const { argv } = Parser.detailed([...args], {
		string: ["api-host", "oauth-host", "profile", "api-key", "config-dir"],
		alias: {
			"api-host": ["apiHost"],
			"oauth-host": ["oauthHost"],
			"api-key": ["apiKey"],
			"config-dir": ["configDir"],
		},
		// `--api-key -` reads the key from stdin; the dash is its value.
		narg: { "api-key": 1 },
		configuration: {
			"populate--": true,
			"parse-positional-numbers": false,
		},
	});
	const apiHost = lastString(argv["api-host"]);
	const oauthHost = lastString(argv["oauth-host"]);
	return {
		flags: {
			...(apiHost !== undefined ? { apiHost } : {}),
			...(oauthHost !== undefined ? { oauthHost } : {}),
		},
		configDir: lastString(argv["config-dir"]) ?? defaultDir,
		profile: credentialProfile({
			apiKeyFlag: lastString(argv["api-key"]) ?? "",
			profileFlag: lastString(argv.profile) ?? "",
			apiKeyEnv: env.NEON_API_KEY ?? "",
			profileEnv: env.NEON_PROFILE ?? "",
		}),
	};
};

const credentialProfile = (inputs: SelectionInput): string | undefined => {
	try {
		const selection = selectCredential(inputs);
		return selection.source === "profile" ? selection.profile : undefined;
	} catch {
		// `--api-key` with `--profile`. `ensureAuth` refuses the pair; until then no profile applies.
		return undefined;
	}
};

export const resolveHosts = (
	flags: ProfileHosts,
	recorded: ProfileHosts,
	env: NodeJS.ProcessEnv = process.env,
): Hosts => ({
	apiHost:
		flags.apiHost ??
		recorded.apiHost ??
		env.NEON_API_HOST ??
		DEFAULT_API_HOST,
	oauthHost:
		flags.oauthHost ??
		recorded.oauthHost ??
		env.NEON_OAUTH_HOST ??
		DEFAULT_OAUTH_HOST,
});

/**
 * The hosts recorded on a named profile. A missing or unreadable `profiles.json` yields none:
 * every command that goes on to use the profile's credential fails on that file with its own
 * message, and one that never touches the credential has no use for the hosts.
 */
const recordedHosts = (
	configDir: string,
	profile: string | undefined,
): ProfileHosts => {
	if (profile === undefined || profile === DEFAULT_PROFILE) return {};
	const read = inspectProfiles(configDir);
	if (read.kind !== "ok") return {};
	const entry = read.file.profiles[profile];
	return entry === undefined ? {} : hostsOf(entry);
};

/** The hosts this invocation uses, for the profile credential selection picks. */
export const invocationHosts = (
	args: readonly string[] = hideBin(process.argv),
	env: NodeJS.ProcessEnv = process.env,
): Hosts => {
	const { flags, configDir, profile } = parseInvocation(args, env);
	return resolveHosts(flags, recordedHosts(configDir, profile), env);
};

/** The hosts for a command that names its profile itself: `login --profile`, `profile <sub> <name>`. */
export const hostsForProfile = (
	configDir: string,
	profile: string,
	args: readonly string[] = hideBin(process.argv),
): Hosts =>
	resolveHosts(
		parseInvocation(args, process.env).flags,
		recordedHosts(configDir, profile),
	);

/**
 * Where a profile's stored credential was issued, for revoking it when it is replaced: its
 * recorded hosts, else the ones this invocation uses.
 */
export const issuingHosts = (
	configDir: string,
	profile: string,
	current: Hosts,
): Hosts => {
	const recorded = recordedHosts(configDir, profile);
	return {
		apiHost: recorded.apiHost ?? current.apiHost,
		oauthHost: recorded.oauthHost ?? current.oauthHost,
	};
};

/**
 * What a sign-in or `profile create` writes to the profile's hosts: each typed flag, with the
 * production URL removing the recorded host. DEFAULT records none. Call it before any request,
 * so a mistyped URL fails having changed nothing.
 */
export const hostUpdateFor = (
	profile: string,
	args: readonly string[] = hideBin(process.argv),
): HostUpdate => {
	if (profile === DEFAULT_PROFILE) return {};
	const { flags } = parseInvocation(args, process.env);
	return {
		...hostUpdate("api-host", flags.apiHost, DEFAULT_API_HOST, "apiHost"),
		...hostUpdate(
			"oauth-host",
			flags.oauthHost,
			DEFAULT_OAUTH_HOST,
			"oauthHost",
		),
	};
};

const hostUpdate = (
	flag: string,
	value: string | undefined,
	production: string,
	field: keyof ProfileHosts,
): HostUpdate => {
	if (value === undefined) return {};
	if (!isHttpUrl(value)) {
		throw new Error(
			`--${flag} must be an http or https URL, such as ${production}.`,
		);
	}
	return {
		[field]: value.replace(/\/+$/, "") === production ? null : value,
	};
};
