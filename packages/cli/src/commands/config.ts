import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packagesToStage, resolveConfig } from "@neon/config";
import {
	apply,
	assertZipWithinLimits,
	type Config,
	type ConflictReport,
	createBranch as createBranchFromPolicy,
	describeNativeFinding,
	enforceLimits,
	type FunctionBundler,
	findUndeclaredNativePackages,
	inspect,
	isPartialBranchCreateError,
	loadConfigFromFile,
	type NeonApi,
	PushConflictError,
	type PushResult,
	plan,
	traceNativePackages,
} from "@neon/config-runtime";
import chalk from "chalk";
import type yargs from "yargs";
import { getApiClient, type NeonApiClient } from "../api.js";
import { type NeonConfigView, toNeonConfigView } from "../config_format.js";
import { declaredNeonServices } from "../config_services.js";
import {
	CONFIG_INIT_NONE_MEANS,
	CONFIG_INIT_SERVICES,
	CONFIG_INIT_UNAVAILABLE,
	FUNCTION_FILENAME,
	FUNCTION_SLUG,
	FUNCTION_TEMPLATE,
	REQUIRED_PACKAGES,
	renderNeonConfig,
	renderNeonConfigFromView,
} from "../config_template.js";

import { contextBranch, readContextFile } from "../context.js";
import { isCi } from "../env.js";
import { loadEnvFileIntoProcess } from "../env_file.js";
import { log } from "../log.js";
import {
	deprecatedServiceMessage,
	type NeonService,
	parseServices,
	servicesFlagValue,
	servicesOption,
} from "../neon_services.js";
import type { BranchScopeProps } from "../types.js";
import {
	assertAiGatewayProvisionable,
	warnAiGateway,
} from "../utils/ai_gateway_notice.js";
import { announceTargetBranch } from "../utils/branch_notice.js";
import { getCliName } from "../utils/cli_name.js";
import {
	renderAppliedChanges,
	renderBranchSettingConflicts,
} from "../utils/config_diff.js";
import { fillSingleProject, resolveBranchRef } from "../utils/enrichers.js";
import { bundleEntry } from "../utils/esbuild.js";
import {
	formatInstallCommand,
	installArgs,
	resolvePackageManager,
	runCommand,
} from "../utils/package_manager.js";
import { pickServicesInteractively } from "../utils/service_picker.js";
import { zipBundle } from "../utils/zip.js";
import { writer } from "../writer.js";
import { autoPullEnvAfterPin } from "./env.js";

/**
 * Bundle a function with neonctl's OWN bundler (the shared esbuild helper) so the
 * config-runtime never has to import esbuild itself. Injecting this keeps esbuild
 * out of config-runtime's static module graph — and therefore out of the packaged
 * neonctl snapshot, which resolves esbuild dynamically at deploy time.
 */
const neonctlBundler: FunctionBundler = async (fn) => {
	const externalPackages = fn.externalPackages ?? [];
	const { files, metafile, warnings } = await bundleEntry(fn.source, {
		externalPackages: externalPackages.map((pkg) => pkg.name),
	});
	for (const warning of warnings) log.warning(warning);

	// Advisory only — the evidence cannot prove the code path is reached, so a package with a
	// working JavaScript fallback must not have its deploy blocked. See native-detect.
	for (const finding of findUndeclaredNativePackages({
		metafile,
		declared: externalPackages.map((pkg) => pkg.name),
		projectDir: dirname(fn.source),
	})) {
		log.warning(describeNativeFinding(fn.slug, finding));
	}

	const staged = packagesToStage(externalPackages);
	// Nothing to stage is the pre-existing path: zip the esbuild output and nothing else,
	// producing the archive it always did.
	if (staged.length === 0) return zipBundle(files);

	// Staged packages are installed for the runtime target, traced, and merged in under their
	// `node_modules/...` paths. The tree layout is load-bearing — a `.node` addon finds its
	// sibling shared libraries relative to its own directory.
	const traced = await traceNativePackages({
		slug: fn.slug,
		packages: staged,
		projectDir: dirname(fn.source),
	});
	for (const warning of traced.warnings) log.warning(warning);
	const entries = { ...files, ...traced.entries };
	// Re-checked against the final archive: the staged files were measured without the
	// bundle, so the entry count and uncompressed total are only complete now.
	enforceLimits(fn.slug, entries);
	const zip = zipBundle(entries);
	assertZipWithinLimits(fn.slug, zip, entries);
	return zip;
};

const INSPECT_FIELDS = ["project", "branch", "config"] as const;

export type ConfigProps = BranchScopeProps & {
	/** Explicit path to a neon.ts policy. When omitted, loadConfigFromFile walks up from cwd. */
	config?: string;
	/**
	 * Optional path to a `.env` file loaded into `process.env` **before** the `neon.ts`
	 * policy is evaluated, so function `env` values that read `process.env.X` pick up the
	 * right per-environment values without juggling shells. Existing `process.env` entries
	 * win over the file.
	 */
	env?: string;
	/** Auto-confirm overriding existing remote settings (apply only). */
	updateExisting?: boolean;
	/** Auto-confirm applying to a protected branch (apply only). */
	allowProtected?: boolean;
	/** `status` only: print just the neon.ts-shaped config JSON to stdout. */
	configJson?: boolean;
	/**
	 * `status` only: print ONLY the linked branch name from the local `.neon` file
	 * (no network). Prints the branch and exits 0 when one is pinned; exits non-zero
	 * when none is (so a shell prompt can guard on it) — unlike `git branch
	 * --show-current`, which exits 0 when detached. Wins over `--config-json` and
	 * ignores `--output`. See {@link isCurrentBranchProbe} for the offline guard.
	 */
	currentBranch?: boolean;
	/**
	 * After a successful `config apply` / `deploy`, pull the branch's Neon env vars into a
	 * local `.env` (DATABASE_URL, AI Gateway, object storage, …) — the same convenience as
	 * `link` / `checkout`. On by default; `--no-env-pull` sets this `false`.
	 */
	envPull?: boolean;
	/**
	 * Working directory used to resolve `neon.ts` and write the `.env` during the bundled env
	 * pull. Defaults to `process.cwd()`; set by tests to redirect the write to a temp dir.
	 */
	cwd?: string;
	/** Injected NeonApi adapter (tests). Production omits it so the real adapter is built from credentials. */
	runtimeApi?: NeonApi;
	/** Global `--color` flag (default true); `--no-color` sets it false to force plain output. */
	color?: boolean;
};

/**
 * Shared `--env` flag for `config plan|apply` and `deploy`. Loads a `.env` into
 * `process.env` before the policy is evaluated.
 */
export const envFlag = {
	env: {
		describe:
			"Path to a .env file to load into the environment before evaluating neon.ts " +
			"(so function env values resolve from it). Existing env vars are not overridden.",
		type: "string",
	},
} as const;

/** Apply-only flags, exported so `deploy` can reuse the exact same surface. */
export const applyFlags = {
	"update-existing": {
		describe:
			"Auto-confirm overriding existing remote settings on the branch",
		type: "boolean",
		default: false,
	},
	"allow-protected": {
		describe: "Auto-confirm applying to a branch marked protected on Neon",
		type: "boolean",
		default: false,
	},
} as const;

/**
 * `--env-pull` for `config apply` / `deploy` (shared so both expose the identical surface).
 * After a successful apply, the branch's Neon env vars are written to a local `.env` — the
 * same bundled convenience as `link` / `checkout`. On by default; `--no-env-pull` opts out.
 */
export const envPullFlag = {
	"env-pull": {
		describe:
			"Pull the branch's Neon env vars (DATABASE_URL, …) into a local .env after a " +
			"successful apply. On by default; use --no-env-pull to skip (e.g. when injecting " +
			"env at runtime with `neon-env run` / `neon dev`).",
		type: "boolean",
		default: true,
	},
} as const;

// ── `config init` ─────────────────────────────────────────────────────────────

/** package.json fields a dependency can be declared in. */
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

/** Config filenames the runtime loads (mirrors @neon/config's loader). */
const NEON_CONFIG_FILENAMES = ["neon.ts", "neon.mts", "neon.js", "neon.mjs"];

/** Whether `dir` already has a Neon config file the runtime would load. */
export const hasNeonConfigFile = (dir: string): boolean =>
	NEON_CONFIG_FILENAMES.some((name) => existsSync(join(dir, name)));

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * The {@link REQUIRED_PACKAGES} not already declared in the project's package.json
 * (any dependency field). A missing or malformed package.json means none are
 * declared, so all are reported missing.
 */
const missingDependencies = (cwd: string): string[] => {
	const declared = new Set<string>();
	const pkgPath = join(cwd, "package.json");
	if (existsSync(pkgPath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
		} catch {
			parsed = undefined;
		}
		if (isRecord(parsed)) {
			for (const field of DEPENDENCY_FIELDS) {
				const deps = parsed[field];
				if (isRecord(deps)) {
					for (const name of Object.keys(deps)) declared.add(name);
				}
			}
		}
	}
	return REQUIRED_PACKAGES.filter((pkg) => !declared.has(pkg));
};

export type ConfigInitProps = {
	/** Directory to scaffold into / resolve package.json from. Defaults to cwd. */
	cwd?: string;
	/**
	 * Install the missing config packages. On by default; `--no-install` just
	 * prints the command to run by hand.
	 */
	install?: boolean;
	/** Injected command runner (tests). Defaults to the real spawn-based runner. */
	run?: typeof runCommand;
	/**
	 * Raw `--services` values: {@link CONFIG_INIT_SERVICES} names, repeated and/or
	 * comma-separated, or `none` for the bare starter policy. When omitted,
	 * {@link resolveServices} picks interactively on a TTY and falls back to the starter
	 * policy otherwise.
	 */
	services?: readonly string[];
	/** Injected service picker (tests). Wins over the TTY check; production omits it. */
	pickServices?: () => Promise<NeonService[]>;
	/**
	 * `--from-branch`: seed the policy from a branch's live Neon state instead of asking.
	 * The one path in `config init` that reaches the API — {@link isConfigInit} stops
	 * skipping auth and project resolution when it is set.
	 */
	fromBranch?: boolean;
	/**
	 * Branch scoping for `--from-branch`, supplied by the `config` command's `--project-id` /
	 * `--branch` options, the `.neon` context middleware, and the global auth middleware. All
	 * optional because every other path in this command runs with none of it.
	 */
	apiClient?: NeonApiClient;
	apiKey?: string;
	apiHost?: string;
	projectId?: string;
	branch?: string;
	/** Injected NeonApi adapter (tests). Production omits it so it's built from credentials. */
	runtimeApi?: NeonApi;
};

/**
 * Which services the scaffolded policy declares. `--services` always wins so a script or an
 * agent gets the same result without a TTY; an injected picker is next (tests); the real
 * picker only runs on an interactive terminal outside CI. Everything else scaffolds the
 * starter policy, which is what `config init` has always written.
 */
const resolveServices = async (
	props: ConfigInitProps,
): Promise<NeonService[]> => {
	if (props.services !== undefined) {
		return parseServices(props.services, {
			allowed: CONFIG_INIT_SERVICES,
			whyUnavailable: CONFIG_INIT_UNAVAILABLE,
			flag: "--services",
			noneMeans: CONFIG_INIT_NONE_MEANS,
			onDeprecated: (used, canonical) =>
				log.warning(deprecatedServiceMessage(used, canonical)),
		});
	}
	if (props.pickServices) {
		return props.pickServices();
	}
	if (isCi() || !process.stdout.isTTY) {
		return [];
	}
	return pickServicesInteractively();
};

/**
 * Write the hello-world handler the scaffolded `preview.functions` entry points at. An
 * existing `hello.ts` is left alone: the declared function keeps pointing at it, which is the
 * better outcome than overwriting a file the user wrote.
 */
const scaffoldFunction = (cwd: string): void => {
	const path = join(cwd, FUNCTION_FILENAME);
	if (existsSync(path)) {
		log.info(
			"Found an existing %s — leaving it untouched; the %s function points at it.",
			FUNCTION_FILENAME,
			FUNCTION_SLUG,
		);
		return;
	}
	writeFileSync(path, FUNCTION_TEMPLATE);
	log.info(
		"Created %s — the source of the %s function.",
		FUNCTION_FILENAME,
		FUNCTION_SLUG,
	);
};

/**
 * Read a branch's live state and render it as a `neon.ts`. The read goes through the same
 * {@link liveConfigView} as `config status`, so a seeded policy declares exactly what
 * `config status --config-json` reports — including what it cannot report (see
 * {@link renderNeonConfigFromView}).
 */
const seedFromBranch = async (
	props: ConfigInitProps,
): Promise<{ source: string; seeded: boolean; branchName: string }> => {
	const { apiClient, projectId } = props;
	if (!apiClient || !projectId) {
		throw new Error(
			"--from-branch needs a project. Pass --project-id, or run `neon link` to pin one in .neon.",
		);
	}

	const ref = await resolveBranchRef({
		apiClient,
		projectId,
		...(props.branch !== undefined ? { branch: props.branch } : {}),
	});
	if (ref.usedDefault) {
		log.info(
			"No branch pinned or passed — seeding from the project's default branch %s.",
			ref.branchName,
		);
	}

	const { live, view } = await liveConfigView({
		projectId,
		branchId: ref.branchId,
		...(props.apiKey ? { apiKey: props.apiKey } : {}),
		...(props.apiHost ? { apiHost: props.apiHost } : {}),
		...(props.runtimeApi ? { runtimeApi: props.runtimeApi } : {}),
	});
	const rendered = renderNeonConfigFromView(view, live.branch.name);
	return { ...rendered, branchName: live.branch.name };
};

/**
 * Scaffold a `neon.ts` policy and make sure the Neon config packages are
 * installed, so a project can go straight to `neon config plan` / `apply`.
 * Local-only unless `--from-branch` is set (see {@link isConfigInit}).
 */
export const initCmd = async (props: ConfigInitProps): Promise<void> => {
	const cwd = props.cwd ?? process.cwd();
	const run = props.run ?? runCommand;

	// 1. Scaffold neon.ts unless the project already has a Neon config file. Resolving the
	// services (which may prompt) happens only when there is something to write — asking
	// which services to declare and then declaring nothing would be a lie.
	const existing = NEON_CONFIG_FILENAMES.find((name) =>
		existsSync(join(cwd, name)),
	);
	if (existing) {
		log.info("Found an existing %s — leaving it untouched.", existing);
	} else if (props.fromBranch) {
		const { source, seeded, branchName } = await seedFromBranch(props);
		writeFileSync(join(cwd, "neon.ts"), source);
		if (seeded) {
			log.info("Created neon.ts from the live state of %s.", branchName);
		} else {
			log.info(
				"%s declares no services and no branch settings — created neon.ts with the starter policy instead.",
				branchName,
			);
		}
	} else {
		const services = await resolveServices(props);
		writeFileSync(join(cwd, "neon.ts"), renderNeonConfig(services));
		if (services.length === 0) {
			log.info("Created neon.ts with a starter policy.");
		} else {
			log.info("Created neon.ts declaring %s.", services.join(", "));
		}
		if (services.includes("functions")) {
			scaffoldFunction(cwd);
		}
	}

	// 2. Make sure the config packages are installed.
	const missing = missingDependencies(cwd);
	if (missing.length === 0) {
		log.info("%s are already installed.", REQUIRED_PACKAGES.join(" and "));
	} else {
		const pm = resolvePackageManager(cwd);
		const args = installArgs(pm, missing);
		if (props.install === false) {
			log.info(
				"Install the Neon config packages to use neon.ts: %s",
				formatInstallCommand(pm, missing),
			);
		} else {
			log.info("Installing %s with %s…", missing.join(", "), pm);
			const ok = await run(pm, args, cwd);
			if (!ok) {
				log.warning(
					"Could not install the config packages automatically. Run by hand: %s",
					formatInstallCommand(pm, missing),
				);
			}
		}
	}

	log.info(
		"Next: edit neon.ts, then run `neon config plan` to preview and `neon config apply`.",
	);
};

export const command = "config";
export const describe = "Manage a branch with a neon.ts policy";
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 config <sub-command> [options]")
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
			branch: {
				describe: "Branch ID or name",
				type: "string",
			},
		})
		.middleware(fillSingleProject as any)
		.command(
			"status",
			"Show the branch's live Neon state",
			(yargs) =>
				yargs.options({
					"config-json": {
						describe:
							"Print only the branch's live config as neon.ts-shaped JSON " +
							"(services + branch tuning + preview), to stdout. Useful for " +
							"scripting or copying into a neon.ts.",
						type: "boolean",
						default: false,
					},
					"current-branch": {
						describe:
							"Print only the linked branch name from the local .neon file " +
							"(no network). Exits non-zero when no branch is pinned.",
						type: "boolean",
						default: false,
					},
				}),
			(args) => status(args as any),
		)
		.command(
			"plan",
			"Show what `config apply` would change (dry run)",
			(yargs) =>
				yargs.options({
					config: {
						describe:
							"Path to a neon.ts policy (defaults to walking up from cwd)",
						type: "string",
					},
					...envFlag,
				}),
			(args) => planCmd(args as any),
		)
		.command(
			"apply",
			"Apply a neon.ts policy to the branch",
			(yargs) =>
				yargs.options({
					config: {
						describe:
							"Path to a neon.ts policy (defaults to walking up from cwd)",
						type: "string",
					},
					...envFlag,
					...applyFlags,
					...envPullFlag,
				}),
			(args) => applyCmd(args as any),
		)
		.command(
			"init",
			"Scaffold a neon.ts policy and install the Neon config packages",
			(yargs) =>
				yargs.options({
					install: {
						describe:
							"Install @neon/config and @neon/env if they're missing. " +
							"On by default; use --no-install to just print the command.",
						type: "boolean",
						default: true,
					},
					services: servicesOption({
						key: "services",
						allowed: CONFIG_INIT_SERVICES,
						noneMeans: CONFIG_INIT_NONE_MEANS,
						describe: "Services the scaffolded neon.ts declares",
						also:
							"Omitted: pick interactively on a terminal, starter policy in " +
							"CI or without a TTY.",
					}),
					"from-branch": {
						describe:
							"Seed neon.ts from a branch's live Neon state instead of asking. Uses the " +
							"branch pinned in .neon, or --branch <name|id>, or the project's default " +
							"branch. The only mode of `config init` that calls the Neon API.",
						type: "boolean",
						// No `default`: yargs counts a defaulted key as provided, so
						// `default: false` makes `conflicts` reject every `--services` run.
						conflicts: "services",
					},
				}),
			(args) =>
				initCmd({
					...(args as any),
					// `args` is untyped here, and "flag omitted" has to stay distinct from
					// "flag given" — it decides whether the picker runs at all.
					services: servicesFlagValue(args.services),
				}),
		);

export const handler = (args: yargs.Argv) => {
	return args;
};

/**
 * A branch's live state, plus that state projected into the `neon.ts`-shaped
 * {@link NeonConfigView}. Shared by `config status` and `config init --from-branch` so both
 * read the branch through one path: what `status --config-json` prints is exactly what
 * `init --from-branch` writes.
 *
 * The pulled `config` carries the branch's tuning inside a closure that JSON can't render, so
 * it is resolved against the live branch target first.
 */
const liveConfigView = async (opts: {
	projectId: string;
	branchId: string;
	apiKey?: string;
	apiHost?: string;
	runtimeApi?: NeonApi;
}): Promise<{
	live: Awaited<ReturnType<typeof inspect>>;
	view: NeonConfigView;
}> => {
	const live = await inspect({
		projectId: opts.projectId,
		branchId: opts.branchId,
		...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
		...(opts.apiHost ? { apiHost: opts.apiHost } : {}),
		...(opts.runtimeApi ? { api: opts.runtimeApi } : {}),
	});
	const resolved = resolveConfig(live.config, {
		name: live.branch.name,
		id: live.branch.id,
		exists: true,
		isDefault: live.branch.isDefault,
		isProtected: live.branch.protected,
		...(live.branch.parent ? { parentId: live.branch.parent } : {}),
		...(live.branch.expiresAt ? { expiresAt: live.branch.expiresAt } : {}),
	});
	return { live, view: toNeonConfigView(resolved, live.preview) };
};

const loadConfig = async (props: ConfigProps): Promise<Config> => {
	// Load the optional --env file FIRST so a `neon.ts` whose function `env` values read
	// `process.env.X` sees them. Must happen before the policy module is imported/evaluated.
	if (props.env) {
		const applied = loadEnvFileIntoProcess(props.env);
		log.debug(
			"Loaded %d var(s) from %s into the environment: %s",
			applied.length,
			props.env,
			applied.join(", "),
		);
	}
	const { config } = await loadConfigFromFile({
		...(props.config ? { path: props.config } : {}),
	});
	return config;
};

export const status = async (props: ConfigProps): Promise<void> => {
	// `--current-branch` short-circuits here (before resolveBranchRef), so it wins
	// over --config-json and ignores --output. See ConfigProps.currentBranch / isCurrentBranchProbe.
	if (props.currentBranch) {
		const branch = contextBranch(readContextFile(props.contextFile));
		if (branch) {
			process.stdout.write(`${branch}\n`);
		} else {
			// No branch pinned: hint on stderr and exit non-zero (grep-style) so a prompt's
			// `when` hides the segment cleanly instead of rendering a bare icon.
			log.info(
				`No branch pinned. Run \`${getCliName()} checkout <branch>\` to pin a branch and pull its env vars.`,
			);
			process.exitCode = 1;
		}
		return;
	}

	const branch = await resolveBranchRef(props);
	// `--config-json` is a script-friendly mode that emits only JSON to stdout, so keep it
	// pristine; the regular human view gets the "which branch am I inspecting" guardrail.
	if (!props.configJson) {
		announceTargetBranch(props, branch, "Inspecting branch");
	}
	const { live, view: configView } = await liveConfigView({
		projectId: props.projectId,
		branchId: branch.branchId,
		...(props.apiKey ? { apiKey: props.apiKey } : {}),
		...(props.apiHost ? { apiHost: props.apiHost } : {}),
		...(props.runtimeApi ? { runtimeApi: props.runtimeApi } : {}),
	});

	// `--config-json`: emit just the neon.ts-shaped config to stdout (script-friendly,
	// copy-paste-able), regardless of the global --output.
	if (props.configJson) {
		process.stdout.write(`${JSON.stringify(configView, null, 2)}\n`);
		return;
	}

	// Default: the live project/branch tables, but with the unhelpful raw `config` replaced
	// by the resolved neon.ts-shaped view so the user sees enabled infra + branch tuning.
	writer(props).end(
		{ project: live.project, branch: live.branch, config: configView },
		{ fields: INSPECT_FIELDS },
	);
};

export const planCmd = async (props: ConfigProps): Promise<void> => {
	const config = await loadConfig(props);
	const branch = await resolveBranchRef(props);
	announceTargetBranch(props, branch, "Planning against branch");
	const branchId = branch.branchId;
	// `plan` is a dry run that never bundles, so its options don't accept (or need)
	// an injected bundler — only `apply` does (it uses neonctlBundler).
	const result = await plan(config, {
		projectId: props.projectId,
		branchId,
		...(props.apiKey ? { apiKey: props.apiKey } : {}),
		...(props.apiHost ? { apiHost: props.apiHost } : {}),
		...(props.runtimeApi ? { api: props.runtimeApi } : {}),
	});
	const services = utilizedServices(config);
	reportPushResult(props, result, "plan", services);

	// `plan` is a dry run and never pulls credentials, so it can only offer the plan-based
	// (Free) AI Gateway notice — the reduced-model-set check needs a live gateway token,
	// which `apply`/`checkout`/`env pull` get via the bundled env pull. Best-effort.
	if (services.includes("AI Gateway")) {
		await warnAiGateway({
			apiClient: props.apiClient,
			projectId: props.projectId,
			branchId,
		});
	}
};

export const applyCmd = async (props: ConfigProps): Promise<void> => {
	const config = await loadConfig(props);
	const branch = await resolveBranchRef(props);
	announceTargetBranch(props, branch, "Applying to branch");
	const branchId = branch.branchId;

	// The AI Gateway can't serve on the Free plan, so refuse to provision it up front rather
	// than write a credential that won't work. Only when the policy actually enables the
	// gateway; best-effort on the plan lookup (a transient failure never blocks a paid user).
	if (utilizedServices(config).includes("AI Gateway")) {
		await assertAiGatewayProvisionable({
			apiClient: props.apiClient,
			projectId: props.projectId,
		});
	}

	let result: PushResult;
	try {
		result = await apply(config, {
			projectId: props.projectId,
			branchId,
			...(props.apiKey ? { apiKey: props.apiKey } : {}),
			...(props.apiHost ? { apiHost: props.apiHost } : {}),
			...(props.runtimeApi ? { api: props.runtimeApi } : {}),
			...(props.updateExisting ? { updateExisting: true } : {}),
			...(props.allowProtected ? { allowProtectedBranch: true } : {}),
			bundleFunction: neonctlBundler,
		});
	} catch (err) {
		// Drift without `--update-existing` throws with the conflicting fields attached.
		// Render them as the same git-style before→after diff, then fail with a concise
		// message (the detailed diff above replaces the library's long multi-line text).
		if (err instanceof PushConflictError) {
			reportConflicts(props, err.conflicts);
			throw new Error(
				"Branch settings conflict with the policy. Re-run with --update-existing to apply the changes shown above.",
			);
		}
		throw err;
	}
	reportPushResult(props, result, "apply", utilizedServices(config));

	// After a successful apply/deploy, write the branch's Neon env vars to a local .env —
	// the same bundled convenience as `link` / `checkout`, so the branch is immediately
	// usable for local dev. `--no-env-pull` opts out; a pull failure degrades to a warning
	// (the apply already succeeded). See autoPullEnvAfterPin.
	await autoPullEnvAfterPin({ ...props, envPull: props.envPull !== false });
};

type ReportMode = "plan" | "apply";

/**
 * Human-readable list of the services a `neon.ts` policy utilizes on the branch, shown under
 * the plan/apply table. Postgres is always present (every branch has it); the rest are listed
 * only when the policy declares them. This deliberately surfaces services that produce **no**
 * plan step — notably the AI Gateway, which is always available and only needs a scoped branch
 * credential (not a provisioning step) — so adding `preview.aiGateway` to a neon.ts isn't
 * mistaken for being silently dropped. Service enablement is static top-level config (it never
 * lives in the per-branch closure), so reading it straight off `config` is accurate.
 */
const utilizedServices = (config: Config): string[] => {
	const labels: Record<NeonService, string> = {
		postgres: "Postgres",
		auth: "Neon Auth",
		"data-api": "Data API",
		"object-storage": "Object Storage",
		functions: "Functions",
		"ai-gateway": "AI Gateway",
	};
	return [
		labels.postgres,
		...declaredNeonServices(config).map((service) => labels[service]),
	];
};

/**
 * Render a {@link PushResult}. JSON/YAML output emits the raw result (plus a `services`
 * summary) verbatim so it can be piped; the human-readable path renders the actual changes
 * (dropping noops) and any blocking conflicts as a `git diff`-style report, or a "nothing to
 * do" line when both are empty — and always closes with the list of services the policy
 * utilizes so a service that produces no plan step (Postgres, or the credential-gated AI
 * Gateway) isn't mistaken for being missing from the plan above.
 *
 * The diff is asymmetric on purpose (see the CLI's `neon diff`): **service** changes are
 * additions with no "before", so they list as `+`/`~` lines; **branch setting** changes have
 * a natural before→after, so conflicts render as a sorted `current → desired` diff. Planned
 * branch updates (under `--update-existing`) carry only the new value, so they render
 * desired-only for now (the previous value isn't threaded through the runtime yet).
 */
const reportPushResult = (
	props: ConfigProps,
	result: PushResult,
	mode: ReportMode,
	services: string[],
): void => {
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end({ ...result, services }, { fields: [] });
		return;
	}

	const appliedChanges = result.applied.filter(
		(change) => change.action !== "noop",
	);

	// Deployed functions carry their invocation URL in the change details — collect them so
	// we can list where to call each function without digging through the raw details blob.
	// Keyed by slug so a function never shows twice.
	const functionUrlBySlug = new Map<string, string>();
	for (const change of appliedChanges) {
		const slug = change.details?.slug;
		const invocationUrl = change.details?.invocationUrl;
		if (typeof slug === "string" && typeof invocationUrl === "string") {
			functionUrlBySlug.set(slug, invocationUrl);
		}
	}

	// chalk self-detects TTY/NO_COLOR; `--no-color` (props.color === false) forces plain.
	const color = props.color !== false;
	const out = writer(props);
	// Conflicts never reach here in the CLI: `plan` runs with updateExisting on, and a bare
	// `apply` throws PushConflictError (rendered by reportConflicts). So an empty applied set
	// is the whole story here.
	const noChanges = appliedChanges.length === 0;

	const appliedText = renderAppliedChanges(
		appliedChanges,
		mode === "plan" ? "Planned changes" : "Applied changes",
		{ color },
	);
	if (appliedText) out.text(`${appliedText}\n`);

	// Function URLs are a plain list rather than a table: an invocation URL can be 70+ chars,
	// which makes any bordered table overflow and wrap awkwardly in a normal terminal. A list
	// lets each URL reflow on its own line, and stays copy-pasteable.
	if (functionUrlBySlug.size > 0) {
		const heading =
			mode === "plan" ? "Function URLs (after apply)" : "Function URLs";
		out.text(`\n${isCi() ? heading : chalk.bold(heading)}\n`);
		for (const [slug, invocationUrl] of functionUrlBySlug) {
			out.text(`  • ${slug}: ${invocationUrl}\n`);
		}
	}

	if (noChanges) {
		log.info(
			`No changes — branch ${result.branchName} already matches the policy.`,
		);
	}
	out.text(`\nUtilized services: ${services.join(", ")}\n`);
};

/**
 * Render the branch-setting {@link ConflictReport}s a bare `apply` refused to override (drift
 * without `--update-existing`) as the git-style before→after diff. JSON/YAML output emits the
 * structured conflicts so it can be piped; the human path prints the sorted diff followed by
 * any conflict whose fix is *not* `--update-existing` (e.g. an immutable "no endpoint" case),
 * so nothing the library's error message carried is lost.
 */
const reportConflicts = (
	props: ConfigProps,
	conflicts: readonly ConflictReport[],
): void => {
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end({ conflicts }, { fields: [] });
		return;
	}
	const out = writer(props);
	const text = renderBranchSettingConflicts([...conflicts], {
		color: props.color !== false,
	});
	if (text) out.text(`${text}\n`);
	for (const conflict of conflicts) {
		if (!/updateExisting/i.test(conflict.reason)) {
			out.text(`  ! ${conflict.field}: ${conflict.reason}\n`);
		}
	}
};

/**
 * Block provisioning the AI Gateway on a Free plan from the `checkout` policy paths, which
 * carry raw credentials (`apiKey`/`apiHost`) rather than the CLI's api client. Builds a client
 * from them and defers to {@link assertAiGatewayProvisionable}. Skipped when a `runtimeApi` is
 * injected (tests) or no `apiKey` is available; the interactive commands always have a key.
 */
const assertAiGatewayProvisionableFromCreds = async (props: {
	projectId: string;
	apiKey?: string;
	apiHost?: string;
	runtimeApi?: NeonApi;
	config: Config;
}): Promise<void> => {
	if (props.runtimeApi || !props.apiKey) return;
	if (!utilizedServices(props.config).includes("AI Gateway")) return;
	const apiClient = getApiClient({
		apiKey: props.apiKey,
		...(props.apiHost ? { apiHost: props.apiHost } : {}),
	});
	await assertAiGatewayProvisionable({
		apiClient,
		projectId: props.projectId,
	});
};

/**
 * Apply a `neon.ts` policy to a **freshly created** branch (used by `neonctl checkout`
 * when it creates a branch). No-op when there is no `neon.ts` on the path from cwd up to
 * the repo root — checkout still succeeds, it just has no policy to apply.
 *
 * The branch was just created by us, so we apply non-interactively (`updateExisting` /
 * `allowProtectedBranch`) — there is no pre-existing state a user would be surprised to
 * see overridden. Functions are bundled with neonctl's own esbuild helper.
 */
export const applyPolicyOnCreate = async (props: {
	projectId: string;
	branchId: string;
	apiKey?: string;
	apiHost?: string;
	runtimeApi?: NeonApi;
	/** Directory to search for `neon.ts` from. Defaults to the process cwd. */
	cwd?: string;
	/** Global `--color` flag; `false` forces the plain-text diff. */
	color?: boolean;
}): Promise<void> => {
	let config: Config;
	try {
		({ config } = await loadConfigFromFile({
			...(props.cwd ? { cwd: props.cwd } : {}),
		}));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/Could not find a Neon config file/i.test(message)) return;
		throw err;
	}

	await assertAiGatewayProvisionableFromCreds({
		projectId: props.projectId,
		...(props.apiKey ? { apiKey: props.apiKey } : {}),
		...(props.apiHost ? { apiHost: props.apiHost } : {}),
		...(props.runtimeApi ? { runtimeApi: props.runtimeApi } : {}),
		config,
	});

	log.info("Applying neon.ts policy to the new branch…");
	const result = await apply(config, {
		projectId: props.projectId,
		branchId: props.branchId,
		...(props.apiKey ? { apiKey: props.apiKey } : {}),
		...(props.apiHost ? { apiHost: props.apiHost } : {}),
		...(props.runtimeApi ? { api: props.runtimeApi } : {}),
		updateExisting: true,
		allowProtectedBranch: true,
		bundleFunction: neonctlBundler,
	});
	logPolicyResult(result, { color: props.color !== false });
};

/**
 * Report what applying a `neon.ts` policy changed, using the same `field → value` diff
 * `deploy` prints (see {@link renderAppliedChanges}) rather than a bare list of change
 * identifiers — the identifier alone repeats the branch name once per change and never says
 * *what* was applied, which is the only interesting part on a freshly created branch.
 */
const logPolicyResult = (
	result: PushResult,
	opts: { color: boolean },
): void => {
	const changes = result.applied.filter((c) => c.action !== "noop");
	if (changes.length === 0) {
		log.info("neon.ts applied — no changes were needed.");
		return;
	}
	log.info(
		"%s",
		renderAppliedChanges(
			changes,
			`neon.ts applied — ${changes.length} change${changes.length === 1 ? "" : "s"}:`,
			opts,
		),
	);
};

/**
 * Create a branch **from** the local `neon.ts` policy. Returns `null` when there is no
 * `neon.ts` on the path from cwd up to the repo root, so `neonctl checkout` can fall back to a
 * bare branch create.
 *
 * Unlike a bare create followed by {@link applyPolicyOnCreate}, this evaluates the policy for
 * the **new** branch (`exists: false`): the runtime branches from the policy's `parent` and
 * brings the branch up with its declared TTL / compute settings / services. That's what makes
 * a policy keyed on `!branch.exists` (the common "only configure new branches" shape) take
 * effect on the very first `checkout` — a bare create + `apply` always saw `exists: true` and
 * skipped that block.
 *
 * A branch that was created but whose policy failed to apply is reported through
 * `policyFailure` rather than thrown: the branch is real, so `checkout` still needs to pin it
 * (see the handler) instead of leaving it stranded behind an unchanged `.neon`.
 */
export const createBranchFromPolicyOnCheckout = async (props: {
	projectId: string;
	branchName: string;
	apiKey?: string;
	apiHost?: string;
	runtimeApi?: NeonApi;
	/** Directory to search for `neon.ts` from. Defaults to the process cwd. */
	cwd?: string;
	/** Global `--color` flag; `false` forces the plain-text diff. */
	color?: boolean;
}): Promise<{ branchId: string; policyFailure?: string } | null> => {
	let config: Config;
	try {
		({ config } = await loadConfigFromFile({
			...(props.cwd ? { cwd: props.cwd } : {}),
		}));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/Could not find a Neon config file/i.test(message)) return null;
		throw err;
	}

	await assertAiGatewayProvisionableFromCreds({
		projectId: props.projectId,
		...(props.apiKey ? { apiKey: props.apiKey } : {}),
		...(props.apiHost ? { apiHost: props.apiHost } : {}),
		...(props.runtimeApi ? { runtimeApi: props.runtimeApi } : {}),
		config,
	});

	try {
		const { branchId, branchName, result } = await createBranchFromPolicy(
			config,
			{
				projectId: props.projectId,
				branchName: props.branchName,
				...(props.apiKey ? { apiKey: props.apiKey } : {}),
				...(props.apiHost ? { apiHost: props.apiHost } : {}),
				...(props.runtimeApi ? { api: props.runtimeApi } : {}),
				bundleFunction: neonctlBundler,
			},
		);
		log.info(
			"Created branch %s (%s) from neon.ts policy.",
			branchName,
			branchId,
		);
		logPolicyResult(result, { color: props.color !== false });
		return { branchId };
	} catch (err) {
		// The branch exists but its policy didn't fully apply. Hand the id back so checkout
		// pins it and reports the failure with the remediation, rather than aborting with an
		// unpinned context and a branch the next `checkout` would silently accept as-is.
		if (isPartialBranchCreateError(err)) {
			log.info(
				"Created branch %s (%s) from neon.ts policy.",
				err.branchName,
				err.branchId,
			);
			return { branchId: err.branchId, policyFailure: err.reason };
		}
		throw err;
	}
};
