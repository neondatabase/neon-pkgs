import { statSync } from "node:fs";
import { dirname } from "node:path";
import { FUNCTION_SOURCE_ENTRIES } from "@neon/config";
import {
	bundleAsIs,
	describeNativeFinding,
	findUndeclaredNativePackages,
	resolveEsbuildEntry,
	zipFunctionBundle,
} from "@neon/config-runtime";
import type yargs from "yargs";
import { isNeonApiError, retryOnLock } from "../api.js";
import {
	type CustomDomain,
	deleteCustomDomain,
	listCustomDomains,
	registerCustomDomain,
} from "../custom_domains_api.js";
import { readEnvFile, resolveEnvFilePath } from "../env_file.js";
import {
	fetchFunctionTemplates,
	type RegistryIndexEntry,
	type ScaffoldBundleResult,
	scaffoldBundleTemplate,
	scaffoldFunctionTemplate,
	UnknownFunctionTemplateError,
} from "../functions/templates.js";
import {
	createDeployment,
	deleteFunction,
	getFunction,
	listFunctions,
	type NeonFunction,
	type NeonFunctionDeployment,
} from "../functions_api.js";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import { getCliName } from "../utils/cli_name.js";
import { branchIdFromProps, fillSingleProject } from "../utils/enrichers.js";
import { bundleEntry } from "../utils/esbuild.js";
import { zipBundle } from "../utils/zip.js";
import { writer } from "../writer.js";
import { DEPLOY_COMMANDS_EPILOGUE } from "./deploy_help.js";

const FUNCTION_FIELDS = [
	"slug",
	"name",
	"invocation_url",
	"created_at",
] as const;

const FUNCTIONS_LIST_LIMIT = 100;
const CUSTOM_DOMAINS_LIST_LIMIT = 100;
const FUNCTION_TEMPLATE_FIELDS = [
	"id",
	"title",
	"provider",
	"description",
] as const;

const CUSTOM_DOMAIN_FIELDS = [
	"domain",
	"entity_type",
	"entity_id",
	"cname_target",
] as const;

// Table columns for `functions list`. `status` is a derived field (the
// table writer reads flat fields only): the current deployment's status.
const LIST_TABLE_FIELDS = [
	"slug",
	"name",
	"status",
	"invocation_url",
	"created_at",
] as const;

const DEPLOYMENT_FIELDS = [
	"id",
	"status",
	"runtime",
	"memory_mib",
	"created_at",
] as const;

// Deploy emits the resolved deployment plus the function's invocation_url, so a
// successful `functions deploy` tells the user exactly where to call the function.
const DEPLOY_RESULT_FIELDS = [
	"id",
	"status",
	"invocation_url",
	"runtime",
	"memory_mib",
	"created_at",
] as const;

// In table mode a failed build's reason gets its own "deployment error"
// section after the deployment table; json/yaml carry the raw `error` field.
const writeDeploymentErrorSection = (
	out: ReturnType<typeof writer>,
	dep: NeonFunctionDeployment,
) => {
	if (dep.status === "failed" && dep.error) {
		out.write(
			{ reason: dep.error },
			{ fields: ["reason"], title: "deployment error" },
		);
	}
};

const SLUG_PATTERN = /^[a-z0-9]{1,20}$/;
const SLUG_HELP =
	"Use 1-20 lowercase letters and digits (no hyphens or other characters).";

// Overridable so tests can poll fast; defaults to 2s in real use.
const POLL_INTERVAL_MS =
	Number(process.env.NEON_FUNCTIONS_POLL_INTERVAL_MS) || 2000;

// Upper bound on --wait polling so the CLI never hangs (e.g. if our deployment
// never shows up as current_deployment). Overridable so tests can time out fast;
// defaults to 10 minutes in real use.
const POLL_TIMEOUT_MS =
	Number(process.env.NEON_FUNCTIONS_POLL_TIMEOUT_MS) || 600_000;

export const command = "functions";
export const describe = "Manage Neon Functions";
export const aliases = ["function"];
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 function <sub-command> [options]")
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
			"new [template]",
			"Create a function from a template",
			(yargs) =>
				yargs
					.positional("template", {
						describe:
							"Template ID (run `neon functions templates list` to see available templates)",
						type: "string",
					})
					.options({
						name: {
							describe:
								"Function slug and output directory name (defaults to the template ID)",
							type: "string",
						},
						operation: {
							describe:
								"Operation to expose (repeatable). Run the command to see a template's operation ids. With no flag and no TTY, every recommended operation is used.",
							type: "string",
							array: true,
						},
						"all-operations": {
							describe:
								"Expose every operation the template declares. Conflicts with --operation.",
							type: "boolean",
						},
						yes: {
							alias: ["y", "default"],
							describe:
								"Skip prompts: use the template's recommended operations and do not ask.",
							type: "boolean",
						},
						dir: {
							describe:
								"Destination directory (defaults to functions/<name>)",
							type: "string",
						},
						force: {
							describe:
								"Overwrite colliding files in a non-empty destination without prompting. Use --no-force to decline without prompting.",
							type: "boolean",
						},
						install: {
							describe:
								"Install dependencies declared by the template. When omitted, interactive terminals ask.",
							type: "boolean",
						},
						"add-to-config": {
							describe:
								"Register the function in neon.ts (creating one if none exists). On by default; use --no-add-to-config to keep it local and deploy manually.",
							type: "boolean",
						},
						config: {
							describe:
								"Path to the neon.ts policy to edit or create (defaults to searching up from the current directory, then creating ./neon.ts).",
							type: "string",
						},
						env: {
							describe:
								"Add the template's required variables to a project dotenv file (a TTY prompts for values; otherwise blank placeholders). On by default; use --no-env to skip.",
							type: "boolean",
						},
						"env-to": {
							describe:
								"Project dotenv file to append missing variables to (inside the project root; defaults to an existing .env.local/.env or a new .env.local).",
							type: "string",
						},
					}),
			(args) => createFromTemplate(args as any),
		)
		.command("templates", "Browse function templates", (yargs) =>
			yargs.command(
				"list",
				"List available function templates",
				(yargs) => yargs,
				(args) => listTemplates(args as any),
			),
		)
		.command(
			"deploy <slug>",
			"Deploy a function from a local directory",
			(yargs) =>
				yargs
					.positional("slug", {
						describe:
							"Function slug (1-20 lowercase letters and digits)",
						type: "string",
						demandOption: true,
					})
					.options({
						src: {
							describe:
								"Function source: a directory containing index.ts, index.js, or index.mjs (first file match is the entry), or a path to the entry file",
							type: "string",
						},
						// Removed flags, kept hidden so old invocations fail loudly instead
						// of being silently ignored (the CLI has no .strictOptions()).
						path: {
							type: "string",
							hidden: true,
						},
						entry: {
							type: "string",
							hidden: true,
						},
						runtime: {
							describe: "Function runtime",
							type: "string",
							choices: ["nodejs24"],
						},
						env: {
							describe:
								"Environment variable as KEY=VALUE (repeatable)",
							type: "string",
							array: true,
						},
						"env-from-file": {
							describe:
								"Load environment variables from a dotenv file. Repeated --env values override matching file entries.",
							type: "string",
						},
						wait: {
							describe:
								"Wait for the deployment to finish building",
							type: "boolean",
							default: true,
						},
						// Named `bundle` so yargs exposes `--no-bundle`, matching `--no-wait`.
						bundle: {
							describe:
								"Bundle --src with esbuild. Use --no-bundle to zip a prebuilt directory (root must contain index.mjs or index.js) or a file of that name.",
							type: "boolean",
							default: true,
						},
					})
					.epilogue(DEPLOY_COMMANDS_EPILOGUE),
			(args) => deploy(args as any),
		)
		.command(
			"list",
			"List functions on the branch",
			(yargs) => yargs,
			(args) => list(args as any),
		)
		.command(
			"get <slug>",
			"Show a function's details",
			(yargs) =>
				yargs
					.positional("slug", {
						describe: "Function slug",
						type: "string",
						demandOption: true,
					})
					.options({
						"list-env-variables": {
							describe:
								"List the environment variable names of the active deployment",
							type: "boolean",
							alias: "E",
							default: false,
						},
					}),
			(args) => get(args as any),
		)
		.command(
			"delete <slug>",
			"Delete a function on the branch",
			(yargs) =>
				yargs.positional("slug", {
					describe: "Function slug",
					type: "string",
					demandOption: true,
				}),
			(args) => deleteFn(args as any),
		)
		.command(
			["domains", "domain"],
			"Manage custom domains on the branch (beta)",
			(yargs) =>
				yargs
					.demandCommand(1)
					.command(
						"list",
						"List custom domains on the branch",
						(yargs) => yargs,
						(args) => listDomains(args as any),
					)
					.command(
						"register <domain>",
						"Point a domain you already own at a function on the branch",
						(yargs) =>
							yargs
								.positional("domain", {
									describe:
										"Domain you already own (for example docs.example.com)",
									type: "string",
									demandOption: true,
								})
								.options({
									slug: {
										describe:
											"Function slug this domain should point at",
										type: "string",
										demandOption: true,
									},
								}),
						(args) => registerDomain(args as any),
					)
					.command(
						"delete <domain>",
						"Delete a custom domain from the branch",
						(yargs) =>
							yargs.positional("domain", {
								describe: "Custom domain",
								type: "string",
								demandOption: true,
							}),
						(args) => deleteDomain(args as any),
					),
		);

export const handler = (args: yargs.Argv) => {
	return args;
};

type NewFunctionProps = Pick<BranchScopeProps, "output"> & {
	template?: string;
	name?: string;
	operation?: string[];
	allOperations?: boolean;
	yes?: boolean;
	dir?: string;
	force?: boolean;
	install?: boolean;
	addToConfig?: boolean;
	config?: string;
	env?: boolean;
	envTo?: string;
};

// Fields for the structured (json/yaml) result of `functions new`. Table mode
// keeps the human next steps logged by the scaffolder; scripts get this record.
const NEW_FUNCTION_FIELDS = [
	"template",
	"provider",
	"layout",
	"operations",
	"routes",
	"functions",
	"slug",
	"directory",
	"installed",
	"dependencies",
	"environment",
	"env_file",
	"config",
	"neon_ts_fragment",
	"next_steps",
] as const;

// Structured (json/yaml) fields for a bundled (prebuilt) artifact. Distinct from
// NEW_FUNCTION_FIELDS: a bundle has no operations/routes/layout, and instead
// reports the verified artifact (bytes/sha256), its prebuilt entry, and the
// platform metadata (capabilities, dependsOn, triggers, migrations) our CLI does
// not yet orchestrate.
const NEW_BUNDLE_FIELDS = [
	"template",
	"provider",
	"delivery",
	"slug",
	"directory",
	"entry",
	"bytes",
	"sha256",
	"capabilities",
	"depends_on",
	"triggers",
	"registered_triggers",
	"unsupported_triggers",
	"migrations",
	"environment",
	"injected_environment",
	"env_file",
	"config",
	"neon_ts_fragment",
	"next_steps",
] as const;

const emitBundleResult = (
	props: NewFunctionProps,
	result: ScaffoldBundleResult,
): void => {
	writer(props).end(
		{
			template: result.templateId,
			provider: result.provider ?? "Neon",
			delivery: "bundle",
			slug: result.slug,
			directory: result.directory,
			entry: result.entry ?? null,
			bytes: result.bytes,
			sha256: result.sha256,
			capabilities: result.capabilities,
			depends_on: result.dependsOn,
			triggers: result.triggers,
			registered_triggers: result.registeredTriggers,
			unsupported_triggers: result.unsupportedTriggers.map((trigger) => ({
				type: trigger.type,
				reason: trigger.reason,
				...(trigger.description
					? { description: trigger.description }
					: {}),
			})),
			migrations: result.migrations,
			environment: result.environment,
			injected_environment: result.injectedEnvironment,
			env_file: result.envFile
				? {
						path: result.envFile.path,
						variables: result.envFile.variables,
						written: result.envFile.written,
					}
				: null,
			config: result.config ?? null,
			neon_ts_fragment: result.neonTsFragment ?? null,
			next_steps: result.nextSteps,
		},
		{ fields: NEW_BUNDLE_FIELDS },
	);
};

const createFromTemplate = async (props: NewFunctionProps) => {
	if (props.template === undefined) {
		await listTemplates(props);
		if (props.output === "table") {
			log.info(
				`Create one with: ${getCliName()} functions new <template>`,
			);
		}
		return;
	}
	const structured = props.output === "json" || props.output === "yaml";
	const registry = await fetchFunctionTemplates();
	const entry = registry.find((candidate) => candidate.id === props.template);

	// Bundled catalog blocks are prebuilt: their operations share one entry and
	// cannot be pruned, so operation selection is rejected up front.
	if (entry?.delivery?.mode === "bundle") {
		if ((props.operation?.length ?? 0) > 0 || props.allOperations) {
			throw new Error(
				`"${entry.id}" is a prebuilt bundle; its operations share one entry and cannot be selected. Remove --operation and --all-operations.`,
			);
		}
		const bundleResult = await scaffoldBundleTemplate({
			entry,
			name: props.name,
			yes: props.yes,
			dir: props.dir,
			force: props.force,
			addToConfig: props.addToConfig,
			config: props.config,
			noEnv: props.env === false,
			envTo: props.envTo,
			quiet: structured,
		});
		if (bundleResult.cancelled) return;
		if (structured) emitBundleResult(props, bundleResult);
		return;
	}

	let result: Awaited<ReturnType<typeof scaffoldFunctionTemplate>>;
	try {
		result = await scaffoldFunctionTemplate({
			template: props.template,
			name: props.name,
			operations: props.operation,
			allOperations: props.allOperations,
			yes: props.yes,
			dir: props.dir,
			force: props.force,
			install: props.install,
			addToConfig: props.addToConfig,
			config: props.config,
			noEnv: props.env === false,
			envTo: props.envTo,
			quiet: structured,
			registry,
		});
	} catch (error) {
		if (!(error instanceof UnknownFunctionTemplateError)) throw error;
		throw new Error(
			`${error.message}\n\nAvailable templates:\n${renderFunctionTemplates(error.templates)}\n\nCreate one with: ${getCliName()} functions new <template>`,
		);
	}
	if (result.cancelled) return;
	if (!structured) return;
	writer(props).end(
		{
			template: result.template.id,
			provider: result.template.provider ?? "Neon",
			layout: result.layout,
			operations: result.operations,
			routes: result.routes,
			functions: result.functions,
			slug: result.slug,
			directory: result.directory,
			installed: result.installed,
			dependencies: result.dependencies,
			environment: result.environment,
			env_file: result.envFile
				? {
						path: result.envFile.path,
						variables: result.envFile.variables,
						written: result.envFile.written,
					}
				: null,
			config: result.config ?? null,
			neon_ts_fragment: result.neonTsFragment ?? null,
			next_steps: result.nextSteps,
		},
		{ fields: NEW_FUNCTION_FIELDS },
	);
};

type FunctionTemplateOutputProps = Pick<BranchScopeProps, "output"> & {
	out?: NodeJS.WritableStream;
};

const writeFunctionTemplates = (
	props: FunctionTemplateOutputProps,
	templates: RegistryIndexEntry[],
): void => {
	const structured = props.output === "json" || props.output === "yaml";
	writer(props).end(
		templates.map(({ id, title, provider, description, logo }) => ({
			id,
			title,
			provider: provider ?? "Neon",
			description,
			...(structured && logo ? { logo } : {}),
		})),
		{
			fields: structured
				? [...FUNCTION_TEMPLATE_FIELDS, "logo"]
				: FUNCTION_TEMPLATE_FIELDS,
			emptyMessage: "No function templates found.",
		},
	);
};

const renderFunctionTemplates = (templates: RegistryIndexEntry[]): string => {
	let output = "";
	const out = {
		write(chunk: string | Uint8Array) {
			output += chunk.toString();
			return true;
		},
	} as unknown as NodeJS.WritableStream;
	writeFunctionTemplates({ output: "table", out }, templates);
	return output.trimEnd();
};

const listTemplates = async (
	props: FunctionTemplateOutputProps,
): Promise<void> => {
	const templates = await fetchFunctionTemplates();
	writeFunctionTemplates(props, templates);
};

type DeployProps = BranchScopeProps & {
	slug: string;
	src?: string;
	path?: string;
	entry?: string;
	runtime?: string;
	env?: string[];
	envFromFile?: string;
	wait: boolean;
	bundle: boolean;
};

export const parseDeployEnvironment = (
	entries: string[] | undefined,
	envFromFile: string | undefined,
	cwd: string,
): string | undefined => {
	const map: Record<string, string> =
		envFromFile === undefined
			? {}
			: readEnvFile(resolveEnvFilePath(cwd, envFromFile));
	for (const entry of entries ?? []) {
		const eq = entry.indexOf("=");
		if (eq <= 0) {
			throw new Error(
				`Invalid --env value "${entry}". Expected KEY=VALUE.`,
			);
		}
		map[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	// Omit environment entirely when nothing resolved, even with --env-from-file: an
	// empty or comment-only file must not send `{}`, which would wipe a
	// function's existing environment on redeploy instead of leaving it untouched.
	if (Object.keys(map).length === 0) return undefined;
	return JSON.stringify(map);
};

const statusHint = (slug: string, projectId: string, branchId: string) =>
	`Check status with: ${getCliName()} function get ${slug} --project-id ${projectId} --branch ${branchId}`;

// Emit the resolved deployment together with the function's invocation_url, so the
// deploy output shows where the function is reachable (not just the deployment id).
const emitDeployResult = (
	props: DeployProps,
	deployment: NeonFunctionDeployment,
	fn: NeonFunction | undefined,
) => {
	const out = writer(props).write(
		{ ...deployment, invocation_url: fn?.invocation_url },
		{ fields: DEPLOY_RESULT_FIELDS },
	);
	if (props.output !== "json" && props.output !== "yaml") {
		writeDeploymentErrorSection(out, deployment);
	}
	out.end();
};

// A poll error worth retrying: a network error (no HTTP response), a 5xx, or a
// 404 from eventual consistency. Anything else (e.g. 401/403) is surfaced.
const isTransient = (err: unknown): boolean =>
	isNeonApiError(err) &&
	(err.status === undefined || err.status === 404 || err.status >= 500);

const deploy = async (props: DeployProps) => {
	if (props.path !== undefined || props.entry !== undefined) {
		throw new Error(
			"--path and --entry were removed. Use --src <dir>; the entry point " +
				`is discovered as ${FUNCTION_SOURCE_ENTRIES.join(", ")} in that directory.`,
		);
	}

	// Defaults do not count as deploy options; explicit `--no-bundle` does.
	const hasOption =
		props.src !== undefined ||
		props.env !== undefined ||
		props.envFromFile !== undefined ||
		props.runtime !== undefined ||
		props.bundle === false;
	if (!hasOption) {
		throw new Error(
			"Provide at least one option to deploy, e.g. --src, --env-from-file, --env, or --no-bundle. " +
				`See: ${getCliName()} function deploy --help.`,
		);
	}

	// Cheap, offline validation first - fail before any network round-trip.
	if (!SLUG_PATTERN.test(props.slug)) {
		throw new Error(`Invalid function slug "${props.slug}". ${SLUG_HELP}`);
	}

	const src = props.src ?? ".";
	const runtime = props.runtime ?? "nodejs24";

	const environment = parseDeployEnvironment(
		props.env,
		props.envFromFile,
		process.cwd(),
	);
	const srcStat = statSync(src, { throwIfNoEntry: false });
	if (srcStat === undefined) {
		throw new Error(`--src path not found: ${src}.`);
	}

	let zip: Uint8Array;
	if (!props.bundle) {
		zip = await zipFunctionBundle(
			props.slug,
			await bundleAsIs(
				{
					slug: props.slug,
					name: props.slug,
					source: src,
					env: {},
					runtime: "nodejs24",
					bundler: "none",
				},
				{ via: "no-bundle" },
			),
		);
	} else {
		const source = await resolveEsbuildEntry(src);
		const bundled = await bundleEntry(source);
		for (const warning of bundled.warnings) log.warning(warning);
		// `--src` bypasses `neon.ts`, so native packages cannot be declared here.
		for (const finding of findUndeclaredNativePackages({
			metafile: bundled.metafile,
			declared: [],
			projectDir: dirname(source),
		})) {
			log.warning(describeNativeFinding(props.slug, finding));
		}
		zip = zipBundle(bundled.files);
	}
	const branchId = await branchIdFromProps(props);

	// Snapshot the current version before deploy so we can detect the new one
	// afterward. A missing function (404) or no deployment yet → undefined.
	let before: number | undefined;
	try {
		const fn = await getFunction(
			props.apiClient,
			props.projectId,
			branchId,
			props.slug,
		);
		before = fn.current_deployment?.id;
	} catch (err: unknown) {
		if (!(isNeonApiError(err) && err.status === 404)) throw err;
	}

	await retryOnLock(() =>
		createDeployment(
			props.apiClient,
			props.projectId,
			branchId,
			props.slug,
			{
				zip,
				runtime,
				environment,
			},
		),
	);
	log.info(`Function deployment triggered for function ${props.slug}.`);

	// Best-effort interrupt: a Ctrl-C lands at the next poll boundary. (No
	// automated test; mirrors the resolution branches below, verified manually.)
	let interrupted = false;
	const onSignal = () => {
		interrupted = true;
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	// Poll until a NEW version appears (id greater than the snapshot, or
	// any version if there was none). --no-wait stops there; --wait stops at a
	// terminal status. Bounded by POLL_TIMEOUT_MS so it never hangs.
	let resolved: NeonFunctionDeployment | undefined;
	// The function carries the invocation_url; keep the whole record (not just its
	// current_deployment) so we can surface that URL on success.
	let resolvedFn: NeonFunction | undefined;
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	try {
		while (!interrupted && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
			if (interrupted) break;
			// The deploy already succeeded server-side; tolerate transient poll
			// failures and retry on the next interval. Surface anything else.
			let fn: NeonFunction | undefined;
			try {
				fn = await getFunction(
					props.apiClient,
					props.projectId,
					branchId,
					props.slug,
				);
			} catch (err: unknown) {
				if (isTransient(err)) continue;
				throw err;
			}
			const dep = fn.current_deployment;
			const isNew =
				dep !== undefined && (before === undefined || dep.id > before);
			if (isNew && dep) {
				resolved = dep;
				resolvedFn = fn;
				if (!props.wait) break;
				if (dep.status === "completed" || dep.status === "failed")
					break;
			}
		}
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
	}

	if (interrupted) {
		log.info(statusHint(props.slug, props.projectId, branchId));
		if (resolved) emitDeployResult(props, resolved, resolvedFn);
		return;
	}

	if (resolved === undefined) {
		log.info(statusHint(props.slug, props.projectId, branchId));
		throw new Error(
			`Timed out waiting for the deployment of ${props.slug} to start. It may still be in progress.`,
		);
	}

	emitDeployResult(props, resolved, resolvedFn);

	if (!props.wait) {
		log.info(statusHint(props.slug, props.projectId, branchId));
		return;
	}
	if (resolved.status === "completed") {
		log.info(`Function deployment ${props.slug}/${resolved.id} completed.`);
		return;
	}
	if (resolved.status === "failed") {
		throw new Error(
			`Function deployment ${props.slug}/${resolved.id} failed.`,
		);
	}

	// --wait, new version appeared but the deadline hit before it finished.
	log.info(statusHint(props.slug, props.projectId, branchId));
	throw new Error(
		`Timed out waiting for function deployment ${props.slug}/${resolved.id} to finish. It may still be building.`,
	);
};

const get = async (
	props: BranchScopeProps & { slug: string; listEnvVariables: boolean },
) => {
	const branchId = await branchIdFromProps(props);
	const fn = await getFunction(
		props.apiClient,
		props.projectId,
		branchId,
		props.slug,
	);

	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(fn, { fields: FUNCTION_FIELDS });
		return;
	}

	const out = writer(props).write(fn, {
		fields: FUNCTION_FIELDS,
		title: "function",
	});
	const current = fn.current_deployment;
	const active = fn.active_deployment;
	if (current && active && current.id === active.id) {
		out.write(current, {
			fields: DEPLOYMENT_FIELDS,
			title: "deployment (current, active)",
		});
		writeDeploymentErrorSection(out, current);
	} else {
		if (current) {
			out.write(current, {
				fields: DEPLOYMENT_FIELDS,
				title: "current deployment",
			});
			// The failure reason is shown only for the current deployment;
			// the active one completed successfully by definition.
			writeDeploymentErrorSection(out, current);
		}
		if (active) {
			out.write(active, {
				fields: DEPLOYMENT_FIELDS,
				title: "active deployment",
			});
		}
	}
	if (props.listEnvVariables) {
		out.write(
			(fn.active_deployment?.environment ?? []).map((name) => ({ name })),
			{
				fields: ["name"],
				title: "environment",
				emptyMessage:
					"No environment variables on the active deployment.",
			},
		);
	}
	out.end();
};

const deleteFn = async (props: BranchScopeProps & { slug: string }) => {
	const branchId = await branchIdFromProps(props);
	try {
		await retryOnLock(() =>
			deleteFunction(
				props.apiClient,
				props.projectId,
				branchId,
				props.slug,
			),
		);
	} catch (err: unknown) {
		if (isNeonApiError(err) && err.status === 404) {
			throw new Error(
				`Function "${props.slug}" not found on branch ${branchId}.`,
			);
		}
		throw err;
	}
	log.info(`Function ${props.slug} deleted from branch ${branchId}`);
};

const list = async (props: BranchScopeProps) => {
	const branchId = await branchIdFromProps(props);
	const functions: NeonFunction[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await listFunctions(
			props.apiClient,
			props.projectId,
			branchId,
			{ cursor, limit: FUNCTIONS_LIST_LIMIT },
		);
		functions.push(...page.functions);
		log.debug(
			"Got %d functions, next cursor: %s",
			page.functions.length,
			page.next,
		);
		// A server echoing the same cursor would loop forever; treat it as
		// the end of the list.
		if (!page.next || page.next === cursor) break;
		cursor = page.next;
	}

	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(functions, { fields: FUNCTION_FIELDS });
		return;
	}

	writer(props).end(
		functions.map((fn) => ({
			...fn,
			status: fn.current_deployment?.status ?? "",
		})),
		{
			fields: LIST_TABLE_FIELDS,
			emptyMessage: "No functions found on this branch.",
		},
	);
};

const listDomains = async (props: BranchScopeProps) => {
	const branchId = await branchIdFromProps(props);
	const domains: CustomDomain[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await listCustomDomains(
			props.apiClient,
			props.projectId,
			branchId,
			{ cursor, limit: CUSTOM_DOMAINS_LIST_LIMIT },
		);
		domains.push(...page.custom_domains);
		if (!page.next || page.next === cursor) break;
		cursor = page.next;
	}

	writer(props).end(domains, {
		fields: CUSTOM_DOMAIN_FIELDS,
		emptyMessage: "No custom domains found on this branch.",
	});
};

const registerDomain = async (
	props: BranchScopeProps & {
		domain: string;
		slug: string;
	},
) => {
	if (!SLUG_PATTERN.test(props.slug)) {
		throw new Error(`Invalid function slug "${props.slug}". ${SLUG_HELP}`);
	}
	const branchId = await branchIdFromProps(props);
	const registered = await retryOnLock(() =>
		registerCustomDomain(props.apiClient, props.projectId, branchId, {
			domain: props.domain,
			entity_type: "function",
			entity_id: props.slug,
		}),
	);
	writer(props).end(registered, { fields: CUSTOM_DOMAIN_FIELDS });
	if (registered.cname_target) {
		log.info(`CNAME ${registered.domain} to ${registered.cname_target}`);
	} else {
		log.info(
			`No CNAME target for ${registered.domain}; this region has no custom-domains front door.`,
		);
	}
};

const deleteDomain = async (props: BranchScopeProps & { domain: string }) => {
	const branchId = await branchIdFromProps(props);
	try {
		await retryOnLock(() =>
			deleteCustomDomain(
				props.apiClient,
				props.projectId,
				branchId,
				props.domain,
			),
		);
	} catch (err: unknown) {
		if (isNeonApiError(err) && err.status === 404) {
			throw new Error(
				`Custom domain "${props.domain}" not found on branch ${branchId}.`,
			);
		}
		throw err;
	}
	log.info(`Custom domain ${props.domain} deleted from branch ${branchId}`);
};
