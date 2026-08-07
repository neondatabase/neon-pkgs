import { spawn } from "node:child_process";
import {
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ErrorCode, externalPackageRoot, PlatformError } from "@neon/config";
import {
	installedPackageVersion,
	readPackageManifest,
} from "./resolve-package.js";

/**
 * The architecture, OS and libc a Neon Function runs on. Native packages are installed for
 * this triple rather than for the machine running the deploy, which is usually a macOS or
 * linux-x64 laptop.
 */
export const RUNTIME_TARGET = {
	cpu: "arm64",
	os: "linux",
	libc: "glibc",
} as const;

/** Human-readable form of {@link RUNTIME_TARGET}, for error messages. */
export const RUNTIME_TARGET_LABEL = `${RUNTIME_TARGET.os}-${RUNTIME_TARGET.cpu} (${RUNTIME_TARGET.libc})`;

/**
 * `e_machine` for AArch64 in an ELF header, and the offsets needed to read it. Used to
 * verify that a binary about to be shipped really is built for the runtime, so a wrong-arch
 * file fails the deploy instead of failing `dlopen` at invoke.
 */
const ELF = {
	magic: "\x7fELF",
	machineOffset: 18,
	headerBytes: 20,
	aarch64: 0xb7,
} as const;

/** Extensions treated as compiled artifacts, whose architecture is worth verifying. */
const BINARY_PATTERN = /\.(node|so)(\.\d+)*$/;

/**
 * The WebAssembly fallback is the one sibling variant that cannot be identified from its
 * manifest: `@img/sharp-wasm32` declares no `os`, `cpu`, or `libc` at all, so npm installs it
 * whatever target is asked for and only the name distinguishes it.
 *
 * Matched as a whole dash-delimited token rather than a substring, so an ordinary package
 * that merely contains the word keeps its files.
 */
const WASM_VARIANT_TOKEN = "wasm32";

/**
 * Whether a package in the staging tree can be left out of the archive.
 *
 * Incompatible builds are identified from their own manifest, the same way npm decides what
 * to install — `@img/sharp-linuxmusl-arm64` declares `libc: ["musl"]`, which a glibc runtime
 * cannot load. That is a fact about the package rather than a guess from its name, so a
 * package called `musl-helper` is untouched.
 *
 * Dropping the wasm build is not merely a size saving: sharp's loader falls through to it
 * silently, so a broken native path would succeed on much slower code instead of failing
 * loudly.
 */
function isExcludedVariant(packageName: string, staging: string): boolean {
	if (packageName.split(/[-/]/).includes(WASM_VARIANT_TOKEN)) return true;
	const manifest = readPackageManifest(
		join(staging, "node_modules", ...packageName.split("/")),
	);
	return manifest !== undefined && !manifestRunsOnRuntime(manifest);
}

/** Whether a manifest's `os`/`cpu`/`libc` permit {@link RUNTIME_TARGET}. */
function manifestRunsOnRuntime(manifest: Record<string, unknown>): boolean {
	const permits = (raw: unknown, value: string): boolean => {
		const field =
			typeof raw === "string"
				? [raw]
				: Array.isArray(raw)
					? raw.filter(
							(entry): entry is string =>
								typeof entry === "string",
						)
					: undefined;
		if (field === undefined || field.length === 0) return true;
		if (field.includes(`!${value}`)) return false;
		const positives = field.filter((entry) => !entry.startsWith("!"));
		return positives.length === 0 || positives.includes(value);
	};
	return (
		permits(manifest.os, RUNTIME_TARGET.os) &&
		permits(manifest.cpu, RUNTIME_TARGET.cpu) &&
		permits(manifest.libc, RUNTIME_TARGET.libc)
	);
}

/** The package a `node_modules/...` archive path belongs to. */
function packageOfArchivePath(path: string): string | undefined {
	const segments = path.split("/");
	if (segments[0] !== "node_modules" || segments.length < 2) return undefined;
	return segments[1].startsWith("@") && segments.length >= 3
		? `${segments[1]}/${segments[2]}`
		: segments[1];
}

/** How long the staging install may take before the deploy gives up on it. */
const INSTALL_TIMEOUT_MS = 120_000;

/**
 * Size ceilings the deploy must respect. The build service rejects an archive over these,
 * with an error that surfaces long after the CLI has exited, so they are checked here where
 * the message can name the files responsible.
 *
 * These mirror the service's limits rather than defining them. Passing them in lets a caller
 * track a change on the service side without editing this module.
 */
export type ArchiveLimits = {
	/** Compressed archive bytes — the ZIP that is uploaded. */
	maxZipBytes: number;
	/** Total uncompressed bytes across every archive entry. */
	maxTotalBytes: number;
	/** Number of archive entries. */
	maxEntries: number;
};

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
	maxZipBytes: 10 * 1024 * 1024,
	maxTotalBytes: 64 * 1024 * 1024,
	maxEntries: 4096,
};

/** Injectable side effects, so the tracing logic is testable without a registry or npm. */
export type NativeTraceDeps = {
	/** Install `specs` for the runtime target into `cwd`. Resolves on success. */
	install: (cwd: string, specs: string[]) => Promise<void>;
	/** Trace `entry` within `base`, returning archive-relative file paths. */
	/**
	 * Trace `entry` within `base`, returning archive-relative file paths.
	 *
	 * The tracer's own warnings are deliberately not surfaced. On a platform-gated package
	 * they are noise and nothing else: `sharp`'s loader names every platform's binary and
	 * probes for the one that exists, so tracing a correctly staged `sharp` emits about a
	 * dozen "could not resolve" warnings — one per platform that was correctly not
	 * installed, plus several for specifiers built by string concatenation that no tracer
	 * can follow. None of them indicates a missing file, and a report that is wrong every
	 * time on the canonical package teaches people to ignore it.
	 *
	 * An archive that really is incomplete is caught by what does prove it: a traced file
	 * that is absent from staging fails the deploy, and a shipped binary that is not an
	 * AArch64 ELF fails it too.
	 */
	trace: (base: string, entry: string) => Promise<{ files: string[] }>;
	/** Version of `pkg` as resolved in the user's project, or undefined if not installed. */
	installedVersion: (projectDir: string, pkg: string) => string | undefined;
};

/** Files to place in the archive under `node_modules/`, keyed by archive-relative path. */
export type NativeTraceResult = {
	entries: Record<string, Uint8Array>;
	/**
	 * Advisory findings from the staging run — currently a package whose version could not be
	 * read from the project, which means the registry's latest was staged instead. The caller
	 * must surface these; a silently different version than the one tested is exactly the
	 * kind of thing that shows up as an unreproducible production bug.
	 */
	warnings: string[];
};

const bytes = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MiB`;

const invalid = (message: string, cause?: unknown): PlatformError =>
	new PlatformError(
		ErrorCode.InvalidConfig,
		message,
		cause === undefined ? undefined : { cause },
	);

/**
 * Collect the files the declared native packages need, ready to be merged into the archive.
 *
 * Three steps, in this order for reasons that are not interchangeable:
 *
 * 1. **Install for the runtime target into a throwaway directory.** The user's own
 *    `node_modules` is never read for these files. Its binaries are built for their machine,
 *    and a cross-platform install is not sticky — a later plain `npm install` re-resolves
 *    optional dependencies for the host and replaces the target's packages with the host's.
 *    Only the resolved *version* of the declared package is taken from the user's tree. That
 *    is not the same as honouring their lockfile: transitive pins, overrides, patches, and
 *    aliases are not carried across, so the staged graph can differ below the root.
 * 2. **Trace the installed tree.** The file set cannot be discovered by asking Node:
 *    `@img/sharp-linux-arm64` exports only `./sharp.node` and `./package`, with no `.` and no
 *    wildcard, so its directory is unreachable through the resolver. A tracer that follows
 *    `createRequire` is required — which is also why esbuild cannot see these files, and why
 *    `sharp` bundles cleanly today and then fails at invoke.
 * 3. **Copy the traced files, preserving the `node_modules` layout.** A `.node` addon locates
 *    its sibling shared libraries by a path relative to its own directory, so flattening the
 *    tree breaks loading even though every file is present.
 */
export async function traceNativePackages(options: {
	slug: string;
	packages: readonly string[];
	projectDir: string;
	limits?: ArchiveLimits;
	deps?: Partial<NativeTraceDeps>;
}): Promise<NativeTraceResult> {
	const { slug, packages, projectDir } = options;
	const limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS;
	const deps: NativeTraceDeps = { ...defaultDeps, ...options.deps };

	// `packages` are the specifiers as authored, which is what the trace entry must import.
	// Installing and verifying work on whole packages, so those use the roots.
	const roots = [...new Set(packages.map(externalPackageRoot))];

	const warnings: string[] = [];
	const specs = roots.map((pkg) => {
		const version = deps.installedVersion(projectDir, pkg);
		// Pin to the user's own resolution when we can see it. Without it we install the
		// registry's latest, which is a different package than the one they tested — said
		// out loud rather than left to be discovered from a deployed archive.
		if (version === undefined) {
			warnings.push(
				`Could not read an installed version of "${pkg}" from this project, so the ` +
					`deploy staged whatever the registry resolves as latest. That may not be the ` +
					`version you tested against. Install "${pkg}" locally to pin it.`,
			);
			return pkg;
		}
		return `${pkg}@${version}`;
	});

	const staging = mkdtempSync(join(tmpdir(), "neon-fn-native-"));
	try {
		// A manifest whose name matches no dependency, and no lockfile, so npm treats the
		// directory as a fresh project and resolves the declared specs on their own.
		writeFileSync(
			join(staging, "package.json"),
			`${JSON.stringify({ name: "neon-fn-native-staging", private: true }, null, 2)}\n`,
		);
		await deps.install(staging, specs);
		verifyInstalled(slug, roots, staging);

		// One entry importing every declared specifier, so a single trace covers them all.
		// The authored specifier rather than the root: a package whose `exports` map lists
		// only a subpath cannot be imported by its root at all.
		writeFileSync(
			join(staging, "trace-entry.mjs"),
			packages.map((pkg) => `import ${JSON.stringify(pkg)};`).join("\n"),
		);

		const traced = await deps.trace(staging, "trace-entry.mjs");
		const files = selectArchiveFiles(slug, traced.files, staging);
		const entries = readArchiveFiles(slug, staging, files);
		enforceLimits(slug, entries, limits);
		return { entries, warnings };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * Fail when a declared package produced no build for the runtime target. npm omits a
 * platform-specific optional dependency silently when none matches, so "installed" does not
 * imply "usable here" — without this check the archive would ship a package whose binary is
 * simply absent, and the failure would surface at invoke.
 */
function verifyInstalled(
	slug: string,
	packages: readonly string[],
	staging: string,
): void {
	for (const pkg of packages) {
		const manifest = join(staging, "node_modules", pkg, "package.json");
		if (lstatSync(manifest, { throwIfNoEntry: false }) === undefined) {
			throw invalid(
				`Function "${slug}" declares "${pkg}" in externalPackages, but it did not ` +
					`install for the Functions runtime (${RUNTIME_TARGET_LABEL}). Either the ` +
					`package does not publish a build for that platform, or it compiles from ` +
					`source at install time, which the deploy cannot do. Check that it lists a ` +
					`${RUNTIME_TARGET.os}-${RUNTIME_TARGET.cpu} build among its optional ` +
					`dependencies. If this function never reaches "${pkg}", exclude it instead: ` +
					`{ name: "${pkg}", includeFiles: false }.`,
			);
		}
	}
}

/**
 * Reduce a trace to the files worth archiving: everything under `node_modules`, minus the
 * sibling platform builds that cannot run on the runtime (see
 * {@link isExcludedVariant}). The trace entry itself is dropped — the real entry is
 * the esbuild bundle.
 */
function selectArchiveFiles(
	slug: string,
	traced: readonly string[],
	staging: string,
): string[] {
	// Decided once per package rather than per file: the exclusion is a property of the
	// package, and its manifest would otherwise be re-read for every file it contributes.
	const excluded = new Map<string, boolean>();
	const dropped = (path: string): boolean => {
		const pkg = packageOfArchivePath(path);
		if (pkg === undefined) return false;
		const known = excluded.get(pkg);
		if (known !== undefined) return known;
		const decision = isExcludedVariant(pkg, staging);
		excluded.set(pkg, decision);
		return decision;
	};

	const files = traced
		.filter(
			(path) =>
				path.startsWith(`node_modules${sep}`) ||
				path.startsWith("node_modules/"),
		)
		.map((path) => path.split(sep).join("/"))
		.filter((path) => !dropped(path))
		.sort();

	if (files.length === 0) {
		throw invalid(
			`Function "${slug}" stages external packages, but tracing the installed packages ` +
				`found no files to ship. This is a bug in the deploy — please report it.`,
		);
	}
	return files;
}

/**
 * Read the traced files, checking each one is shippable as it goes.
 *
 * Two rejections here, both cheaper to hit now than after upload. A symlink cannot be
 * represented in the archive at all, and a compiled binary built for the wrong architecture
 * would deploy fine and then fail to load — which is the exact failure this whole option
 * exists to prevent, so it must not be reintroduced by a stale or hand-patched tree.
 */
function readArchiveFiles(
	slug: string,
	staging: string,
	files: readonly string[],
): Record<string, Uint8Array> {
	const entries: Record<string, Uint8Array> = {};
	for (const relative of files) {
		const absolute = resolve(staging, relative);
		// Defence in depth: a traced path must stay inside the staging tree.
		if (!absolute.startsWith(`${resolve(staging)}${sep}`)) {
			throw invalid(
				`Function "${slug}": traced file "${relative}" resolves outside the staging ` +
					`directory. This is a bug in the deploy — please report it.`,
			);
		}
		// lstat, not stat: stat follows the link and would report the target's type, so a
		// symlink would pass this check silently.
		const stat = lstatSync(absolute, { throwIfNoEntry: false });
		// The tracer said this file is needed and it is not there. Skipping it would ship an
		// archive that is quietly missing something and fail at invoke, which is the failure
		// this whole path exists to prevent.
		if (stat === undefined) {
			throw invalid(
				`Function "${slug}": traced file "${relative}" disappeared before it could be ` +
					`read. This is a bug in the deploy — please report it.`,
			);
		}
		if (stat.isSymbolicLink()) {
			throw invalid(
				`Function "${slug}" would ship a symbolic link, which the build does not ` +
					`support: ${relative}. This is a bug in the deploy — please report it.`,
			);
		}
		if (!stat.isFile()) continue;

		const contents = readFileSync(absolute);
		if (BINARY_PATTERN.test(relative))
			verifyArchitecture(slug, relative, contents);
		entries[relative] = new Uint8Array(contents);
	}
	return entries;
}

/**
 * Reject a compiled artifact that is not built for the runtime. Only ELF AArch64 can load
 * there, so anything else — a Mach-O from the user's laptop, an x64 ELF from a stale
 * install — is a deploy-time error rather than an invoke-time one.
 */
function verifyArchitecture(
	slug: string,
	relative: string,
	contents: Buffer,
): void {
	// Too short to carry an ELF header at all. Returning here would let a truncated or
	// placeholder binary through the one check that exists to stop a wrong-architecture file
	// reaching the runtime.
	if (contents.length < ELF.headerBytes) {
		throw invalid(
			`Function "${slug}" would ship "${relative}", which is ${contents.length} bytes — ` +
				`too short to be a valid binary. The Functions runtime is ` +
				`${RUNTIME_TARGET_LABEL}.`,
		);
	}
	const isElf = contents.subarray(0, 4).toString("binary") === ELF.magic;
	if (!isElf) {
		throw invalid(
			`Function "${slug}" would ship "${relative}", which is not a Linux binary. ` +
				`The Functions runtime is ${RUNTIME_TARGET_LABEL}, so a binary built for ` +
				`another platform cannot load there. A package that compiles from source at ` +
				`install time produces a binary for the machine that installed it and cannot ` +
				`be cross-installed by the deploy.`,
		);
	}
	const machine = contents.readUInt16LE(ELF.machineOffset);
	if (machine !== ELF.aarch64) {
		throw invalid(
			`Function "${slug}" would ship "${relative}", which is built for a different ` +
				`architecture (ELF machine 0x${machine.toString(16)}). The Functions runtime is ` +
				`${RUNTIME_TARGET_LABEL}.`,
		);
	}
}

/**
 * Check the archive against the build service's limits, naming the largest contributors. The
 * compressed size is not known until the archive is zipped, so only the counts and
 * uncompressed total are checked here; {@link assertZipWithinLimits} covers the rest.
 *
 * Exported so the caller can re-check the **final** archive: these entries are the staged
 * files alone, and the bundle is merged in afterwards.
 */
export function enforceLimits(
	slug: string,
	entries: Record<string, Uint8Array>,
	limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): void {
	const names = Object.keys(entries);
	const count = names.length;
	if (count > limits.maxEntries) {
		throw invalid(
			`Function "${slug}" archive has ${count} files; the limit is ${limits.maxEntries}. ` +
				`Native packages bring their whole file tree — ship fewer of them, or split the ` +
				`work across functions.`,
		);
	}
	const total = names.reduce((sum, name) => sum + entries[name].length, 0);
	if (total > limits.maxTotalBytes) {
		throw invalid(
			`Function "${slug}" archive is ${bytes(total)} uncompressed; the limit is ` +
				`${bytes(limits.maxTotalBytes)}.\n\n${describeLargest(entries)}`,
		);
	}
}

/**
 * Check the compressed archive, which is only measurable once it exists. Separate from
 * {@link enforceLimits} for that reason, and exported so the bundler can call it on the
 * finished ZIP.
 */
export function assertZipWithinLimits(
	slug: string,
	zip: Uint8Array,
	entries: Record<string, Uint8Array>,
	limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): void {
	if (zip.length <= limits.maxZipBytes) return;
	throw invalid(
		`Function "${slug}" archive is ${bytes(zip.length)} compressed; the limit is ` +
			`${bytes(limits.maxZipBytes)}.\n\n${describeLargest(entries)}`,
	);
}

/** The handful of files worth naming when an archive is too big. */
function describeLargest(entries: Record<string, Uint8Array>): string {
	const largest = Object.entries(entries)
		.sort(([, a], [, b]) => b.length - a.length)
		.slice(0, 4)
		.map(([name, data]) => `  ${bytes(data.length).padStart(9)}  ${name}`);
	return `Largest contributors:\n${largest.join("\n")}\n\nNative binaries are large. Ship fewer of them, or split the work across functions.`;
}

const defaultDeps: NativeTraceDeps = {
	install: (cwd, specs) => runNpmInstall(cwd, specs),
	trace: async (base, entry) => {
		const { nodeFileTrace } = await loadNft();
		// The entry is passed absolute: nft resolves a relative one against the process cwd,
		// not against `base`. `fileList` still comes back relative to `base`, which is what
		// the archive keys need.
		const result = await nodeFileTrace([join(base, entry)], { base });
		return {
			files: [...result.fileList],
			// A specifier the tracer could not follow is a file that will be missing from the
			// archive and only noticed at invoke. Not fatal — nft warns about plenty that is
			// genuinely optional — but never silent.
			warnings: [...result.warnings].map((warning) => warning.message),
		};
	},
	installedVersion: (projectDir, pkg) =>
		installedPackageVersion(projectDir, pkg),
};

/**
 * Install into the staging directory by shelling out to whatever `npm` is on `PATH`, rather
 * than importing it. The CLI also ships as a standalone binary with no npm and no
 * `node_modules` inside it, so a `require()` would be unresolvable there; a subprocess works
 * in both forms.
 *
 * `--cpu/--os/--libc` are what select the runtime's builds instead of the host's.
 * `--ignore-scripts` matters for more than speed: an install script would compile for the
 * host architecture and overwrite the prebuilt binary we are here to collect.
 */
async function runNpmInstall(cwd: string, specs: string[]): Promise<void> {
	const args = [
		"install",
		...specs,
		`--cpu=${RUNTIME_TARGET.cpu}`,
		`--os=${RUNTIME_TARGET.os}`,
		`--libc=${RUNTIME_TARGET.libc}`,
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--no-package-lock",
		"--loglevel=error",
	];

	const { code, stderr, spawnError } = await new Promise<{
		code: number | null;
		stderr: string;
		spawnError?: Error;
	}>((resolveRun) => {
		const child = spawn("npm", args, {
			cwd,
			stdio: ["ignore", "ignore", "pipe"],
			timeout: INSTALL_TIMEOUT_MS,
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (spawnError) =>
			resolveRun({ code: null, stderr, spawnError }),
		);
		child.on("close", (code) => resolveRun({ code, stderr }));
	});

	if (spawnError !== undefined) {
		const missing = (spawnError as NodeJS.ErrnoException).code === "ENOENT";
		throw invalid(
			missing
				? `Shipping a function's externalPackages requires "npm" on PATH, to install ` +
						`them for the Functions runtime (${RUNTIME_TARGET_LABEL}). It could not ` +
						`be found. Install Node.js with npm, or set includeFiles: false on every ` +
						`entry so nothing needs staging.`
				: `Failed to install externalPackages for the Functions runtime: ${spawnError.message}`,
			spawnError,
		);
	}
	if (code !== 0) {
		// npm reports a package that declares no build for the target as EBADPLATFORM, whose
		// own message compares against the *host* platform and so reads as though the wrong
		// thing was asked for. Say what actually happened instead.
		if (stderr.includes("EBADPLATFORM")) {
			throw invalid(
				`A package in externalPackages has no build for the Functions runtime ` +
					`(${RUNTIME_TARGET_LABEL}), so its files cannot be staged. Use a package ` +
					`that publishes a ${RUNTIME_TARGET.os}-${RUNTIME_TARGET.cpu} build (sharp ` +
					`does). If this function never reaches it, exclude it instead with ` +
					`includeFiles: false.\n\nnpm reported:\n${stderr.trim()}`,
			);
		}
		throw invalid(
			`Failed to install externalPackages for the Functions runtime ` +
				`(${RUNTIME_TARGET_LABEL}). npm exited with code ${code}.\n${stderr.trim()}`,
		);
	}
}

/**
 * Loaded with a dynamic `import()` for the same reason as esbuild and fflate: nothing in this
 * package's static graph should name the tracer, so a `neon.ts` that only reads config never
 * pulls it in. A deploy that declares no native packages never reaches this.
 */
async function loadNft(): Promise<typeof import("@vercel/nft")> {
	try {
		return await import("@vercel/nft");
	} catch (cause) {
		throw invalid(
			"Staging a function's external packages requires `@vercel/nft`, which could not " +
				"be loaded. It is a dependency of @neon/config-runtime — reinstall your " +
				"dependencies (`pnpm install` / `npm install`).",
			cause,
		);
	}
}
