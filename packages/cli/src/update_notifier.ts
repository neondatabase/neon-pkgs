import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import which from "which";
import { isCi } from "./env.js";
import { log } from "./log.js";
import {
	type CliInstallMethod,
	detectCliInstallMethod,
	recommendedCliUpgradeCommand,
} from "./utils/package_manager.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NOTIFY_INTERVAL_MS = 3 * CHECK_INTERVAL_MS;
const CACHE_FILE = "update-check.json";

export type UpdateSource = "homebrew" | "npm";

export type UpdateCheckCache = {
	checkedAt: number;
	latestVersion?: string;
	notifiedAt?: number;
	source: UpdateSource;
};

type UpdateNoticeOptions = {
	currentVersion: string;
	latestVersion: string;
	upgradeCommand: string;
};

type UpdateNotifierOptions = {
	commandPath: string[];
	configDir: string;
	currentBranch: boolean;
	currentVersion: string;
	output: string;
};

type UpdateNotifierEligibility = Pick<
	UpdateNotifierOptions,
	"commandPath" | "currentBranch" | "output"
> & {
	disabled: boolean;
	isCi: boolean;
	isPackaged: boolean;
	stderrIsTty: boolean;
	stdoutIsTty: boolean;
};

type UpdateWorkerProcessOptions = {
	cachePath: string;
	executablePath: string;
	source: UpdateSource;
	workerPath: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const parseUpdateCheckCache = (
	raw: string,
): UpdateCheckCache | undefined => {
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!isRecord(value) ||
			typeof value.checkedAt !== "number" ||
			!Number.isFinite(value.checkedAt) ||
			(value.source !== "homebrew" && value.source !== "npm") ||
			(value.latestVersion !== undefined &&
				typeof value.latestVersion !== "string") ||
			(value.notifiedAt !== undefined &&
				(typeof value.notifiedAt !== "number" ||
					!Number.isFinite(value.notifiedAt)))
		) {
			return undefined;
		}

		return {
			checkedAt: value.checkedAt,
			source: value.source,
			...(value.latestVersion === undefined
				? {}
				: { latestVersion: value.latestVersion }),
			...(value.notifiedAt === undefined
				? {}
				: { notifiedAt: value.notifiedAt }),
		};
	} catch {
		return undefined;
	}
};

const readUpdateCheckCache = (
	cachePath: string,
): UpdateCheckCache | undefined => {
	try {
		return parseUpdateCheckCache(readFileSync(cachePath, "utf8"));
	} catch {
		return undefined;
	}
};

export const writeUpdateCheckCache = (
	cachePath: string,
	cache: UpdateCheckCache,
): boolean => {
	const temporaryPath = `${cachePath}.${process.pid}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(cache)}\n`, {
			mode: 0o600,
		});
		renameSync(temporaryPath, cachePath);
		return true;
	} catch (error) {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {}
		log.debug(
			"Could not write the CLI update cache: %s",
			error instanceof Error ? error.message : String(error),
		);
		return false;
	}
};

export const formatUpdateNotice = ({
	currentVersion,
	latestVersion,
	upgradeCommand,
}: UpdateNoticeOptions): string | undefined => {
	if (
		semver.valid(currentVersion) === null ||
		semver.valid(latestVersion) === null ||
		!semver.gt(latestVersion, currentVersion)
	) {
		return undefined;
	}

	return `Neon CLI update available: ${currentVersion} → ${latestVersion}\n${upgradeCommand}`;
};

export const shouldRefreshUpdateCheck = (
	cache: UpdateCheckCache | undefined,
	now: number,
): boolean => cache === undefined || now - cache.checkedAt >= CHECK_INTERVAL_MS;

export const cacheForUpdateSource = (
	cache: UpdateCheckCache | undefined,
	source: UpdateSource,
): UpdateCheckCache | undefined =>
	cache?.source === source ? cache : undefined;

const isCurrentBranchProbe = ({
	commandPath,
	currentBranch,
}: Pick<UpdateNotifierOptions, "commandPath" | "currentBranch">): boolean =>
	currentBranch &&
	(commandPath[0] === "status" ||
		(commandPath[0] === "config" && commandPath[1] === "status"));

const updateSource = (command: string): UpdateSource =>
	command.startsWith("brew ") ? "homebrew" : "npm";

export const spawnUpdateWorkerProcess = ({
	cachePath,
	executablePath,
	source,
	workerPath,
}: UpdateWorkerProcessOptions): ChildProcess => {
	const child = spawn(executablePath, [workerPath, cachePath, source], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.on("error", (error) => {
		log.debug("CLI update check failed to start: %s", error.message);
	});
	child.unref();
	return child;
};

const spawnUpdateWorker = (cachePath: string, source: UpdateSource): void => {
	const workerPath = fileURLToPath(
		new URL("./update_check_worker.js", import.meta.url),
	);
	if (!existsSync(workerPath)) return;

	try {
		spawnUpdateWorkerProcess({
			cachePath,
			executablePath: process.execPath,
			source,
			workerPath,
		});
	} catch (error) {
		log.debug(
			"Could not start the CLI update check: %s",
			error instanceof Error ? error.message : String(error),
		);
	}
};

export type CliInstall = {
	method: CliInstallMethod | undefined;
	path: string;
};

const INSTALL_LABELS: Record<CliInstallMethod, string> = {
	homebrew: "Homebrew",
	bun: "Bun",
	pnpm: "pnpm",
	npm: "npm",
};

/**
 * `npm exec`, `npx`, package scripts, and `dlx` prepend a project's or a cache's
 * `node_modules/.bin`, which is gone from PATH once the command ends.
 */
const isPackageBin = (executable: string): boolean => {
	const bin = dirname(executable);
	return (
		basename(bin) === ".bin" && basename(dirname(bin)) === "node_modules"
	);
};

/**
 * Every distinct `command` executable on `path`, in PATH order, leaving out
 * package-local `node_modules/.bin` entries. Entries that resolve to the same
 * file (a repeated PATH directory, Homebrew's `bin` and `opt` links) count once.
 */
export const findCliInstalls = (
	command: string,
	path: string | undefined,
): CliInstall[] => {
	const seen = new Set<string>();
	const installs: CliInstall[] = [];
	for (const executable of which.sync(command, {
		all: true,
		nothrow: true,
		path,
	}) ?? []) {
		if (isPackageBin(executable)) continue;
		const target = realpathSync(executable);
		if (seen.has(target)) continue;
		seen.add(target);
		installs.push({
			method: detectCliInstallMethod(target),
			path: executable,
		});
	}
	return installs;
};

type DuplicateInstallNoticeOptions = {
	installs: CliInstall[];
	/** Whether a `neonctl` command outside Homebrew is also on PATH. */
	otherNeonctl: boolean;
};

export const formatDuplicateInstallNotice = ({
	installs,
	otherNeonctl,
}: DuplicateInstallNoticeOptions): string | undefined => {
	if (installs.length < 2) return undefined;

	const rows = installs.map(({ method, path }, index) => {
		const labels = [
			...(method === undefined ? [] : [INSTALL_LABELS[method]]),
			...(index === 0 ? ["first on PATH"] : []),
		];
		return labels.length === 0
			? `  ${path}`
			: `  ${path} (${labels.join(", ")})`;
	});
	const lines = ["Multiple Neon CLI installs found on PATH:", ...rows];

	if (!installs.some(({ method }) => method === "homebrew")) {
		lines.push("Keep one and uninstall the others.");
		return lines.join("\n");
	}

	lines.push(
		installs.some(({ method }) => method === "npm")
			? "Remove the Homebrew install to use npm:"
			: "Remove the Homebrew install:",
		"  brew uninstall neonctl",
	);
	if (!otherNeonctl) {
		lines.push(
			"This also removes the `neonctl` command; run `neon` instead.",
		);
	}
	lines.push("Then open a new shell.");
	return lines.join("\n");
};

const duplicateInstallNotice = (): string | undefined => {
	try {
		const installs = findCliInstalls("neon", process.env.PATH);
		return formatDuplicateInstallNotice({
			installs,
			otherNeonctl: findCliInstalls("neonctl", process.env.PATH).some(
				({ method }) => method !== "homebrew",
			),
		});
	} catch (error) {
		log.debug(
			"Could not check PATH for other Neon CLI installs: %s",
			error instanceof Error ? error.message : String(error),
		);
		return undefined;
	}
};

const isPackagedExecutable = (): boolean => "pkg" in process;

export const shouldRunUpdateNotifier = ({
	commandPath,
	currentBranch,
	disabled,
	isCi: runningInCi,
	isPackaged,
	output,
	stderrIsTty,
	stdoutIsTty,
}: UpdateNotifierEligibility): boolean =>
	!runningInCi &&
	!disabled &&
	!isPackaged &&
	output === "table" &&
	stdoutIsTty &&
	stderrIsTty &&
	commandPath.length > 0 &&
	commandPath[0] !== "completion" &&
	!isCurrentBranchProbe({ commandPath, currentBranch });

export const notifyIfUpdateAvailable = ({
	commandPath,
	configDir,
	currentBranch,
	currentVersion,
	output,
}: UpdateNotifierOptions): void => {
	if (
		!shouldRunUpdateNotifier({
			commandPath,
			currentBranch,
			disabled: "NO_UPDATE_NOTIFIER" in process.env,
			isCi: isCi(),
			isPackaged: isPackagedExecutable(),
			output,
			stderrIsTty: process.stderr.isTTY === true,
			stdoutIsTty: process.stdout.isTTY === true,
		})
	) {
		return;
	}

	// One Windows install puts `neon`, `neon.cmd`, and `neon.ps1` on PATH as separate files,
	// so file identity can't count installs there.
	if (process.platform !== "win32") {
		const duplicateNotice = duplicateInstallNotice();
		if (duplicateNotice !== undefined) {
			// Takes the place of the version notice, which would say `brew upgrade neonctl`.
			log.warning("%s", duplicateNotice);
			return;
		}
	}

	const command = recommendedCliUpgradeCommand(
		fileURLToPath(import.meta.url),
	);
	if (command === undefined) return;

	const cachePath = join(configDir, CACHE_FILE);
	const now = Date.now();
	const source = updateSource(command);
	const cache = cacheForUpdateSource(readUpdateCheckCache(cachePath), source);
	let nextCache = cache;

	if (
		cache?.latestVersion !== undefined &&
		(cache.notifiedAt === undefined ||
			now - cache.notifiedAt >= NOTIFY_INTERVAL_MS)
	) {
		const notice = formatUpdateNotice({
			currentVersion,
			latestVersion: cache.latestVersion,
			upgradeCommand: command,
		});
		if (notice !== undefined) {
			log.warning("%s", notice);
			nextCache = { ...cache, notifiedAt: now };
		}
	}

	if (!shouldRefreshUpdateCheck(cache, now)) {
		if (nextCache !== cache && nextCache !== undefined) {
			writeUpdateCheckCache(cachePath, nextCache);
		}
		return;
	}

	nextCache = { ...nextCache, checkedAt: now, source };
	if (writeUpdateCheckCache(cachePath, nextCache)) {
		spawnUpdateWorker(cachePath, source);
	}
};

export const recordLatestVersion = (
	cachePath: string,
	source: UpdateSource,
	latestVersion: string,
): void => {
	if (semver.valid(latestVersion) === null) return;

	const cache = cacheForUpdateSource(readUpdateCheckCache(cachePath), source);
	if (cache === undefined) return;

	writeUpdateCheckCache(cachePath, {
		...cache,
		latestVersion,
	});
};
