import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import prompts from "prompts";
import type yargs from "yargs";

import { revokeToken } from "../auth.js";
import { isCi } from "../env.js";
import { log } from "../log.js";
import {
	DEFAULT_PROFILE,
	listProfiles,
	onlyDefaultRemains,
	profilesFilePath,
	readProfiles,
	resolveProfile,
	selectProfileName,
} from "../profiles.js";
import type { CommonProps, ExtendedTokenSet } from "../types.js";
import { writer } from "../writer.js";

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

const list = async (props: ProfileProps) => {
	const active = selectProfileName(props.profile);
	const rows = listProfiles(props.configDir).map((p) => ({
		active: p.name === active ? "*" : "",
		name: p.name,
		account: p.label ?? p.userId ?? "-",
		credentials: p.credentialsPath,
		signedIn: existsSync(p.credentialsPath) ? "yes" : "no",
	}));

	writer(props).end(rows, {
		title: "Profiles",
		fields: ["active", "name", "account", "signedIn", "credentials"],
	});
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

	// 1. Revoke upstream, so the token dies rather than merely becoming unreachable by us.
	//    Best-effort: a profile is often removed precisely because its access already broke.
	const revoked = await revokeStoredToken(profile.credentialsPath, props);
	log.info(
		revoked
			? "Revoked the OAuth token"
			: "Could not revoke the OAuth token — removing locally anyway",
	);

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
			writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, {
				mode: 0o600,
			});
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

/** Whether a credentials file is one the CLI created, rather than an adopted path. */
const isInsideConfigDir = (configDir: string, file: string): boolean =>
	`${resolve(file)}/`.startsWith(`${resolve(configDir)}/`);
