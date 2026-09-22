import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { isCi } from "./env.js";
import { log } from "./log.js";
import { recommendedCliUpgradeCommand } from "./utils/package_manager.js";

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
