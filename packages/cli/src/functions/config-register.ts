import {
	existsSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import prompts from "prompts";
import { missingConfigDependencies } from "../commands/config.js";
import {
	formatInstallCommand,
	installArgs,
	type PackageManager,
	resolvePackageManager,
	type runCommand,
} from "../utils/package_manager.js";
import {
	containedSourcePath,
	type DiscoveredConfig,
	discoverConfig,
	NEON_CONFIG_FILENAMES,
	resolveExplicitConfig,
	sameNormalizedSource,
} from "./config-discovery.js";
import {
	analyzeNeonConfig,
	buildFunctionEntry,
	buildTriggerEntry,
	type FunctionDeclaration,
	insertFunction,
	insertTrigger,
	replaceFunction,
	replaceTrigger,
	sameTriggerConfig,
	type TriggerDeclaration,
} from "./config-editor.js";

/** One function to register: a Neon slug plus the file or directory it deploys. */
export type RegisterTarget = {
	slug: string;
	displayName: string;
	/** Absolute path to the file or directory the function's `source` points at. */
	sourcePath: string;
	environment: string[];
	/** Non-default bundler, e.g. `"none"` for a prebuilt bundle directory. */
	bundler?: string;
};

export type RegisterInput = {
	cwd: string;
	/** One target for router/single-file layouts; several for the separate layout. */
	targets: RegisterTarget[];
	/**
	 * Supported function triggers to register alongside the functions, in the same atomic edit.
	 * Each `function` must name a slug this same call registers; the caller drops anything Neon
	 * config cannot express (see the bundle scaffolder).
	 */
	triggers?: TriggerDeclaration[];
	configPath?: string;
	addToConfig?: boolean;
	force?: boolean;
	interactive: boolean;
	install?: boolean;
	confirmRegister?: (message: string) => Promise<boolean | undefined>;
	confirmReplace?: (message: string) => Promise<boolean | undefined>;
};

type DepPlan = {
	missing: string[];
	install: boolean;
	pm: PackageManager;
	command: string;
	root: string;
};

export type ConfigPlan =
	| { kind: "cancelled" }
	| { kind: "skip"; declined: boolean }
	| {
			kind: "fragment";
			fragment: string;
			reason: string;
			suggestInit: boolean;
	  }
	| {
			kind: "noop";
			path: string;
			root: string;
			relativePath: string;
			decls: FunctionDeclaration[];
			triggerDecls?: TriggerDeclaration[];
	  }
	| {
			kind: "create";
			path: string;
			root: string;
			relativePath: string;
			text: string;
			deps: DepPlan;
			decls: FunctionDeclaration[];
			triggerDecls?: TriggerDeclaration[];
	  }
	| {
			kind: "edit";
			action: "updated" | "replaced";
			path: string;
			root: string;
			relativePath: string;
			text: string;
			decls: FunctionDeclaration[];
			triggerDecls?: TriggerDeclaration[];
	  };

export type ConfigOutcome = {
	registered: boolean;
	action?: "created" | "updated" | "replaced" | "noop";
	path?: string;
	relativePath?: string;
	registeredSlugs?: string[];
	/** Names of the triggers written in the same edit. Empty when none were registered. */
	registeredTriggers?: string[];
	fragment?: string;
	reason?: string;
	suggestInit?: boolean;
	declined?: boolean;
	depInstalled?: boolean;
	depCommand?: string;
	hasEnv: boolean;
	envNames: string[];
};

/** The smallest safe, editable neon.ts: the import plus an empty policy object. */
const MINIMAL_CONFIG_STARTER = `import { defineConfig } from "@neon/config/v1";

export default defineConfig({
});
`;

const posix = (value: string): string => value.split(sep).join("/");

const envMap = (names: string[]): Record<string, string> | undefined =>
	names.length === 0
		? undefined
		: Object.fromEntries(
				names.map((name) => [name, `process.env.${name}!`]),
			);

/**
 * The pasteable `functions: { … }` (and, when triggers are supported, `triggers: { … }`) block
 * shown when auto-registration is declined or unsafe.
 */
export const renderFragment = (
	decls: FunctionDeclaration[],
	triggerDecls: TriggerDeclaration[] = [],
): string => {
	const functionEntries = decls
		.map((decl) => `  ${buildFunctionEntry(decl, { includeEnv: true })},`)
		.join("\n");
	const functions = `functions: {\n${functionEntries}\n},`;
	if (triggerDecls.length === 0) return functions;
	const triggerEntries = triggerDecls
		.map((decl) => `  ${buildTriggerEntry(decl)},`)
		.join("\n");
	return `${functions}\ntriggers: {\n${triggerEntries}\n},`;
};

/** One edit in a batch: an insert or replace of either a function or a trigger member. */
type EditOp =
	| {
			kind: "function";
			decl: FunctionDeclaration;
			mode: "insert" | "replace";
	  }
	| { kind: "trigger"; decl: TriggerDeclaration; mode: "insert" | "replace" };

/**
 * Apply a batch of function/trigger edits to a config source, re-analyzing between each so
 * splice offsets stay valid — reusing the single-member editors rather than growing a second,
 * batch-aware editor.
 */
const applyEdits = (
	source: string,
	extension: string,
	ops: EditOp[],
): string => {
	let current = source;
	for (const op of ops) {
		const analysis = analyzeNeonConfig(current, extension);
		if (!analysis.safe) {
			throw new Error(
				`Could not edit the Neon config: ${analysis.reason}.`,
			);
		}
		if (op.kind === "function") {
			current =
				op.mode === "replace"
					? replaceFunction(analysis, op.decl.slug, op.decl)
					: insertFunction(analysis, op.decl);
		} else {
			current =
				op.mode === "replace"
					? replaceTrigger(analysis, op.decl.name, op.decl)
					: insertTrigger(analysis, op.decl);
		}
	}
	return current;
};

const quoteSlugs = (decls: FunctionDeclaration[]): string =>
	decls.map((decl) => `"${decl.slug}"`).join(", ");

const quoteNames = (decls: { name: string }[]): string =>
	decls.map((decl) => `"${decl.name}"`).join(", ");

const joinList = (...parts: string[]): string =>
	parts.filter((part) => part !== "").join(", ");

const defaultConfirm =
	(initial: boolean) =>
	async (message: string): Promise<boolean | undefined> => {
		const answer = await prompts({
			type: "confirm",
			name: "value",
			message,
			initial,
		});
		return typeof answer.value === "boolean" ? answer.value : undefined;
	};

const projectBoundary = (cwd: string): string => {
	let current = resolve(cwd);
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
};

const atomicWrite = (path: string, text: string): void => {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		writeFileSync(tmp, text);
		renameSync(tmp, path);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {}
		throw error;
	}
};

/**
 * Decide, without writing anything, how the scaffolded function should be registered in a Neon
 * config: edit an existing safely-analyzable `neon.ts`, create one (the default when none
 * exists), no-op when it is already declared, or fall back to a pasteable fragment. Every
 * interactive prompt and every failure path runs here — before the scaffold materializes — so a
 * declined prompt or an explicit-flag failure leaves the disk untouched.
 */
export const planConfigRegistration = async (
	input: RegisterInput,
): Promise<ConfigPlan> => {
	if (input.addToConfig === false) return { kind: "skip", declined: false };

	const rel = (path: string): string =>
		relative(input.cwd, path) || basename(path);

	const declFor = (
		target: RegisterTarget,
		source: string,
	): FunctionDeclaration => {
		const env = envMap(target.environment);
		return {
			slug: target.slug,
			name: target.displayName,
			source,
			...(env ? { env } : {}),
			...(target.bundler !== undefined
				? { bundler: target.bundler }
				: {}),
		};
	};

	// Every target as a contained relative source, or undefined when any scaffold
	// path escapes the config's project root.
	const buildDecls = (root: string): FunctionDeclaration[] | undefined => {
		const decls: FunctionDeclaration[] = [];
		for (const target of input.targets) {
			const source = containedSourcePath(root, target.sourcePath);
			if (source === undefined) return undefined;
			decls.push(declFor(target, source));
		}
		return decls;
	};

	// Registration is blocked (unsafe/out-of-root config), so fall back to a
	// pasteable fragment; use a best-effort source even when it escapes the root.
	const bestEffortDecls = (root: string): FunctionDeclaration[] =>
		input.targets.map((target) =>
			declFor(
				target,
				containedSourcePath(root, target.sourcePath) ??
					`./${posix(relative(input.cwd, target.sourcePath))}`,
			),
		);

	// Only register triggers whose target function is registered in this same call —
	// a trigger may never point at a function that isn't present (Neon config rejects
	// that, and it is the "absent function" case we must not create).
	const registeredSlugs = new Set(input.targets.map((target) => target.slug));
	const triggerDecls = (input.triggers ?? []).filter((trigger) =>
		registeredSlugs.has(trigger.function),
	);

	const wantRegister = async (
		message: string,
	): Promise<boolean | undefined> => {
		if (input.addToConfig === true) return true;
		if (!input.interactive) return true;
		return (input.confirmRegister ?? defaultConfirm(true))(message);
	};

	const unsafeExisting = (
		path: string,
		root: string,
		reason: string,
	): ConfigPlan => {
		if (input.addToConfig === true) {
			throw new Error(
				`Cannot register ${quoteSlugs(bestEffortDecls(root))} in ${rel(path)}: ${reason}. Register by hand:\n\n${renderFragment(bestEffortDecls(root), triggerDecls)}`,
			);
		}
		return {
			kind: "fragment",
			fragment: renderFragment(bestEffortDecls(root), triggerDecls),
			reason,
			suggestInit: false,
		};
	};

	const notContained = (root: string): ConfigPlan => {
		const reason =
			"the scaffold directory is outside the config's project root";
		if (input.addToConfig === true) {
			throw new Error(
				`Cannot register ${quoteSlugs(bestEffortDecls(root))}: ${reason}.`,
			);
		}
		return {
			kind: "fragment",
			fragment: renderFragment(bestEffortDecls(root), triggerDecls),
			reason,
			suggestInit: false,
		};
	};

	// insertFunction/insertTrigger always prepend, so inserting in reverse keeps the
	// written order matching selection order. Triggers are inserted before functions
	// so that a freshly created config renders `functions` above `triggers`.
	const functionInsertOps = (decls: FunctionDeclaration[]): EditOp[] =>
		[...decls]
			.reverse()
			.map((decl) => ({ kind: "function", decl, mode: "insert" }));

	const triggerInsertOps = (decls: TriggerDeclaration[]): EditOp[] =>
		[...decls]
			.reverse()
			.map((decl) => ({ kind: "trigger", decl, mode: "insert" }));

	const createOps = (
		decls: FunctionDeclaration[],
		triggers: TriggerDeclaration[],
	): EditOp[] => [...triggerInsertOps(triggers), ...functionInsertOps(decls)];

	const planForExisting = async (
		discovered: DiscoveredConfig,
	): Promise<ConfigPlan> => {
		const { analysis, root, path } = discovered;
		if (!analysis.safe) return unsafeExisting(path, root, analysis.reason);
		const decls = buildDecls(root);
		if (!decls) return notContained(root);

		const safeFunctions = analysis.functions;
		const inserts: FunctionDeclaration[] = [];
		const conflicts: FunctionDeclaration[] = [];
		for (const decl of decls) {
			const existing = safeFunctions.find((fn) => fn.slug === decl.slug);
			if (!existing) {
				inserts.push(decl);
			} else if (
				!(
					existing.source !== undefined &&
					sameNormalizedSource(root, existing.source, decl.source)
				)
			) {
				conflicts.push(decl);
			}
		}

		// Triggers use the same conflict rules as functions: an identical existing
		// declaration is a no-op, a differing one is a conflict resolved by --force
		// or a prompt. Detect every conflict here, before any write.
		const existingTriggers = analysis.triggers;
		const triggerInserts: TriggerDeclaration[] = [];
		const triggerConflicts: TriggerDeclaration[] = [];
		for (const decl of triggerDecls) {
			const existing = existingTriggers.find((t) => t.name === decl.name);
			if (!existing) {
				triggerInserts.push(decl);
			} else if (!sameTriggerConfig(existing, decl)) {
				triggerConflicts.push(decl);
			}
		}

		const conflictItems = joinList(
			quoteSlugs(conflicts),
			quoteNames(triggerConflicts),
		);
		const insertItems = joinList(
			quoteSlugs(inserts),
			quoteNames(triggerInserts),
		);
		const conflictCount = conflicts.length + triggerConflicts.length;
		const insertCount = inserts.length + triggerInserts.length;

		if (insertCount === 0 && conflictCount === 0) {
			return {
				kind: "noop",
				path,
				root,
				relativePath: rel(path),
				decls,
				triggerDecls,
			};
		}

		if (conflictCount > 0) {
			const many = conflictCount > 1;
			if (input.addToConfig === true) {
				if (!input.force) {
					throw new Error(
						`${conflictItems} already declared in ${rel(path)} with a different config. Pass --name to register under a different slug, or --force to replace the existing declaration${many ? "s" : ""}.`,
					);
				}
			} else if (input.interactive) {
				const answer = await (
					input.confirmReplace ?? defaultConfirm(false)
				)(
					`${rel(path)} already declares ${conflictItems} with a different config. Replace ${many ? "them" : "it"}?`,
				);
				if (answer === undefined) return { kind: "cancelled" };
				if (!answer) {
					return {
						kind: "fragment",
						fragment: renderFragment(decls, triggerDecls),
						reason: `kept the existing ${conflictItems} declaration${many ? "s" : ""}`,
						suggestInit: false,
					};
				}
			} else {
				return {
					kind: "fragment",
					fragment: renderFragment(decls, triggerDecls),
					reason: `${conflictItems} already declared with a different config`,
					suggestInit: false,
				};
			}
		} else {
			const answer = await wantRegister(
				`Register ${insertItems} in ${rel(path)}?`,
			);
			if (answer === undefined) return { kind: "cancelled" };
			if (!answer) return { kind: "skip", declined: true };
		}

		const ops: EditOp[] = [
			...triggerInsertOps(triggerInserts),
			...functionInsertOps(inserts),
			...conflicts.map(
				(decl): EditOp => ({ kind: "function", decl, mode: "replace" }),
			),
			...triggerConflicts.map(
				(decl): EditOp => ({ kind: "trigger", decl, mode: "replace" }),
			),
		];
		return {
			kind: "edit",
			action: conflictCount > 0 ? "replaced" : "updated",
			path,
			root,
			relativePath: rel(path),
			text: applyEdits(discovered.source, discovered.extension, ops),
			decls,
			triggerDecls,
		};
	};

	const planForCreate = async (
		targetPath: string,
		explicit: boolean,
	): Promise<ConfigPlan> => {
		const root = dirname(targetPath);
		if (explicit) {
			if (
				!(NEON_CONFIG_FILENAMES as readonly string[]).includes(
					basename(targetPath),
				)
			) {
				throw new Error(
					`--config for a new file must be one of ${NEON_CONFIG_FILENAMES.join(", ")}.`,
				);
			}
			const boundary = projectBoundary(input.cwd);
			const resolvedTarget = resolve(targetPath);
			if (
				resolvedTarget !== join(boundary, basename(targetPath)) &&
				!resolvedTarget.startsWith(boundary + sep)
			) {
				throw new Error(
					`--config path ${rel(targetPath)} is outside the project boundary ${boundary}.`,
				);
			}
		}
		const decls = buildDecls(root);
		if (!decls) return notContained(root);

		const createItems = joinList(
			quoteSlugs(decls),
			quoteNames(triggerDecls),
		);
		const answer = await wantRegister(
			`No Neon config found. Create ${rel(targetPath)} and register ${createItems}?`,
		);
		if (answer === undefined) return { kind: "cancelled" };
		if (!answer) return { kind: "skip", declined: true };

		const extension = extname(targetPath).slice(1).toLowerCase() || "ts";
		const pm = resolvePackageManager(root);
		const missing = missingConfigDependencies(root);
		return {
			kind: "create",
			path: targetPath,
			root,
			relativePath: rel(targetPath),
			// Start from the minimal starter (import + empty defineConfig) and let
			// the shared editor fill in only the functions and triggers required.
			text: applyEdits(
				MINIMAL_CONFIG_STARTER,
				extension,
				createOps(decls, triggerDecls),
			),
			deps: {
				missing,
				install: input.install === true,
				pm,
				command: formatInstallCommand(pm, missing),
				root,
			},
			decls,
			triggerDecls,
		};
	};

	if (input.configPath) {
		const abs = isAbsolute(input.configPath)
			? input.configPath
			: resolve(input.cwd, input.configPath);
		if (existsSync(abs) && statSync(abs).isFile()) {
			return planForExisting(
				resolveExplicitConfig(input.configPath, input.cwd),
			);
		}
		return planForCreate(abs, true);
	}

	const result = discoverConfig(input.cwd);
	switch (result.kind) {
		case "found":
			return planForExisting(result.config);
		case "ambiguous":
			return unsafeExisting(
				join(result.dir, result.names[0]),
				result.dir,
				`multiple Neon config files in ${rel(result.dir) || "."} (${result.names.join(", ")})`,
			);
		case "blocked":
			return unsafeExisting(
				result.path,
				dirname(result.path),
				result.reason,
			);
		case "missing":
			return planForCreate(join(input.cwd, "neon.ts"), false);
	}
};

/**
 * Materialize a {@link ConfigPlan}. Config writes are atomic (temp file + rename) so a failure
 * never leaves a half-written policy, and are performed by the caller **after** the scaffold has
 * been written — a config-write failure is reported but the scaffold (and the fragment) survive.
 */
export const applyConfigPlan = async (
	plan: ConfigPlan,
	opts: { run: typeof runCommand },
): Promise<ConfigOutcome> => {
	if (plan.kind === "cancelled") {
		return { registered: false, hasEnv: false, envNames: [] };
	}
	if (plan.kind === "skip") {
		return {
			registered: false,
			declined: plan.declined,
			hasEnv: false,
			envNames: [],
		};
	}
	if (plan.kind === "fragment") {
		return {
			registered: false,
			fragment: plan.fragment,
			reason: plan.reason,
			suggestInit: plan.suggestInit,
			hasEnv: false,
			envNames: [],
		};
	}

	const envNames = [
		...new Set(plan.decls.flatMap((decl) => Object.keys(decl.env ?? {}))),
	];
	const hasEnv = envNames.length > 0;
	const registeredSlugs = plan.decls.map((decl) => decl.slug);
	const registeredTriggers = (plan.triggerDecls ?? []).map(
		(decl) => decl.name,
	);

	if (plan.kind === "noop") {
		return {
			registered: true,
			action: "noop",
			path: plan.path,
			relativePath: plan.relativePath,
			registeredSlugs,
			registeredTriggers,
			hasEnv,
			envNames,
		};
	}

	if (plan.kind === "edit") {
		atomicWrite(plan.path, plan.text);
		return {
			registered: true,
			action: plan.action,
			path: plan.path,
			relativePath: plan.relativePath,
			registeredSlugs,
			registeredTriggers,
			hasEnv,
			envNames,
		};
	}

	atomicWrite(plan.path, plan.text);
	let depInstalled: boolean | undefined;
	let depCommand: string | undefined;
	if (plan.deps.missing.length > 0) {
		if (plan.deps.install) {
			depInstalled = await opts.run(
				plan.deps.pm,
				installArgs(plan.deps.pm, plan.deps.missing),
				plan.deps.root,
			);
			if (!depInstalled) depCommand = plan.deps.command;
		} else {
			depInstalled = false;
			depCommand = plan.deps.command;
		}
	}
	return {
		registered: true,
		action: "created",
		path: plan.path,
		relativePath: plan.relativePath,
		registeredSlugs,
		registeredTriggers,
		depInstalled,
		depCommand,
		hasEnv,
		envNames,
	};
};
