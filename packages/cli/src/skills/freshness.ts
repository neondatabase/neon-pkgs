import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	openSync,
	readFileSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../log.js";
import { showNotice } from "../notices.js";
import { writeJsonFile } from "../utils/json_file.js";
import { AGENT_SKILLS_SOURCE, PLATFORMS_SKILLS_SOURCE } from "./catalog.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = "skills-check.json";
const FETCH_TIMEOUT_MS = 10_000;
const NEON_SOURCES: ReadonlySet<string> = new Set([
	AGENT_SKILLS_SOURCE,
	PLATFORMS_SKILLS_SOURCE,
]);

export type SkillsScope = "global" | "project";

export const scopeLabel = (scope: SkillsScope): string =>
	scope === "project" ? "this directory" : "user-level";

export const neonSkillsUpdateCommand = (scope: SkillsScope): string =>
	scope === "global"
		? "neon skills update --global -y"
		: "neon skills update -y";

/**
 * A Neon skill as a skills CLI lock file records it. `hash` is the git tree SHA of the skill
 * folder (`tree`) or a SHA-256 of its files (`content`).
 */
export type LockedSkill = {
	scope: SkillsScope;
	skill: string;
	source: string;
	folder: string;
	hash: string;
	hashKind: "tree" | "content";
	/**
	 * Installed from a `ref`. `neon skills` never pins one, and a pinned skill tracks that ref
	 * rather than the default branch, so the update check leaves it out.
	 */
	pinned: boolean;
};

/** Where the skills CLI keeps its user-level lock. */
export const globalLockPath = (env: NodeJS.ProcessEnv = process.env): string =>
	env.XDG_STATE_HOME
		? join(env.XDG_STATE_HOME, "skills", ".skill-lock.json")
		: join(homedir(), ".agents", ".skill-lock.json");

export const projectLockPath = (cwd: string): string =>
	join(cwd, "skills-lock.json");

export const lockPath = (scope: SkillsScope, cwd: string): string =>
	scope === "global" ? globalLockPath() : projectLockPath(cwd);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The Agent Skills name rule. A lock is repository content, and names reach the terminal. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const skillFolder = (skillPath: string): string =>
	skillPath.replace(/\\/g, "/").replace(/\/?SKILL\.md$/i, "");

/**
 * The global lock's `skillFolderHash` is usually a tree SHA, but the skills CLI stores a
 * content SHA-256 there when it installed from a Git clone; it tells them apart by length.
 */
export const parseSkillsLock = (
	raw: string,
	scope: SkillsScope,
): LockedSkill[] => {
	const value: unknown = JSON.parse(raw);
	if (!isRecord(value) || !isRecord(value.skills)) return [];
	const field = scope === "global" ? "skillFolderHash" : "computedHash";
	const skills: LockedSkill[] = [];
	for (const [skill, entry] of Object.entries(value.skills)) {
		if (!isRecord(entry)) continue;
		const { source, skillPath, ref } = entry;
		const hash = entry[field];
		if (
			!SKILL_NAME.test(skill) ||
			typeof source !== "string" ||
			!NEON_SOURCES.has(source) ||
			typeof skillPath !== "string" ||
			typeof hash !== "string" ||
			hash === ""
		) {
			continue;
		}
		const folder = skillFolder(skillPath);
		if (folder === "") continue;
		const hashKind =
			scope === "global" && /^[0-9a-f]{40}$/i.test(hash)
				? "tree"
				: "content";
		skills.push({
			scope,
			skill,
			source,
			folder,
			hash,
			hashKind,
			pinned: ref !== undefined,
		});
	}
	return skills;
};

const readAllLockedSkills = (
	path: string,
	scope: SkillsScope,
): LockedSkill[] => {
	if (!existsSync(path)) return [];
	const raw = readLockFile(path);
	try {
		return parseSkillsLock(raw, scope);
	} catch {
		// The parser quotes the input, which can hold terminal controls.
		throw new Error(`${path} is not valid JSON.`);
	}
};

/** The skills the update check covers: every Neon skill in the lock except pinned ones. */
export const readLockedSkills = (
	path: string,
	scope: SkillsScope,
): LockedSkill[] =>
	readAllLockedSkills(path, scope).filter((skill) => !skill.pinned);

const MAX_LOCK_BYTES = 1024 * 1024;

/**
 * A project lock is repository content: a FIFO would block the open and `/dev/zero` the read,
 * on every command run in that directory.
 */
const readLockFile = (path: string): string => {
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error(`${path} is not a regular file.`);
		if (stat.size > MAX_LOCK_BYTES) {
			throw new Error(`${path} is larger than ${MAX_LOCK_BYTES} bytes.`);
		}
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
};

/**
 * What the skill folder looks like on the source's default branch. `pending` marks a folder
 * a background check was started for, so a failed check is not restarted on every command.
 */
export type RemoteFolder = {
	tree?: string;
	content?: string;
	/** The content hash of the folder as a `core.autocrlf=true` checkout writes it. */
	contentCrlf?: string;
	missing?: true;
	pending?: true;
};

/**
 * `checkedAt` is when the last successful check read GitHub; `attemptedAt` is when a check
 * was last started, which throttles the next one.
 */
export type SkillsCheckCache = {
	checkedAt: number;
	attemptedAt?: number;
	folders: Record<string, RemoteFolder>;
};

const folderKey = ({
	source,
	folder,
}: Pick<LockedSkill, "source" | "folder">): string => `${source}:${folder}`;

export type SkillStatus = "up to date" | "outdated" | "not found upstream";

/** `undefined` when the remote side has not been fetched yet. */
export const skillStatus = (
	skill: LockedSkill,
	remote: RemoteFolder | undefined,
): SkillStatus | undefined => {
	if (remote?.missing === true) return "not found upstream";
	if (skill.hashKind === "tree") {
		if (remote?.tree === undefined) return undefined;
		return remote.tree === skill.hash ? "up to date" : "outdated";
	}
	if (remote?.content === undefined) return undefined;
	if (skill.hash === remote.content) return "up to date";
	// A cache written before `contentCrlf` existed cannot rule out an autocrlf checkout.
	if (remote.contentCrlf === undefined) return undefined;
	return skill.hash === remote.contentCrlf ? "up to date" : "outdated";
};

const parseRemoteFolder = (value: unknown): RemoteFolder | undefined => {
	if (!isRecord(value)) return undefined;
	const { tree, content, contentCrlf, missing, pending } = value;
	if (
		(tree !== undefined && typeof tree !== "string") ||
		(content !== undefined && typeof content !== "string") ||
		(contentCrlf !== undefined && typeof contentCrlf !== "string") ||
		(missing !== undefined && missing !== true) ||
		(pending !== undefined && pending !== true)
	) {
		return undefined;
	}
	return {
		...(tree === undefined ? {} : { tree }),
		...(content === undefined ? {} : { content }),
		...(contentCrlf === undefined ? {} : { contentCrlf }),
		...(missing === undefined ? {} : { missing }),
		...(pending === undefined ? {} : { pending }),
	};
};

export const parseSkillsCheckCache = (
	raw: string,
): SkillsCheckCache | undefined => {
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!isRecord(value) ||
			typeof value.checkedAt !== "number" ||
			!Number.isFinite(value.checkedAt) ||
			!isRecord(value.folders)
		) {
			return undefined;
		}
		const folders: Record<string, RemoteFolder> = {};
		for (const [key, entry] of Object.entries(value.folders)) {
			const folder = parseRemoteFolder(entry);
			if (folder !== undefined) folders[key] = folder;
		}
		const { attemptedAt } = value;
		return {
			checkedAt: value.checkedAt,
			...(typeof attemptedAt === "number" && Number.isFinite(attemptedAt)
				? { attemptedAt }
				: {}),
			folders,
		};
	} catch {
		return undefined;
	}
};

const readSkillsCheckCache = (
	cachePath: string,
): SkillsCheckCache | undefined => {
	try {
		return parseSkillsCheckCache(readFileSync(cachePath, "utf8"));
	} catch {
		return undefined;
	}
};

export const skillsCheckCachePath = (configDir: string): string =>
	join(configDir, CACHE_FILE);

/**
 * The digest the skills CLI writes to `computedHash`: every file's folder-relative path and
 * then its bytes, in `localeCompare` order of path.
 */
export const skillContentHash = (
	files: readonly { path: string; bytes: Uint8Array }[],
): string => {
	const hash = createHash("sha256");
	for (const file of [...files].sort((a, b) =>
		a.path.localeCompare(b.path),
	)) {
		hash.update(file.path);
		hash.update(file.bytes);
	}
	return hash.digest("hex");
};

const LF = 0x0a;
const CR = 0x0d;
/** Control bytes Git counts as printable text: backspace, tab, form feed, escape. */
const PRINTABLE_CONTROLS: ReadonlySet<number> = new Set([
	0x08, 0x09, 0x0c, 0x1b,
]);

/**
 * The bytes Git writes for a blob when `core.autocrlf=true`, the Git for Windows default. The
 * skills CLI hashes that checkout, so a Windows install records a hash of these bytes. Mirrors
 * Git's `convert.c`: a blob that has any CR, a NUL, or mostly non-printable bytes is written
 * unchanged, and every LF in any other blob becomes CRLF.
 */
export const autocrlfCheckout = (bytes: Uint8Array): Uint8Array => {
	let lf = 0;
	let printable = 0;
	let nonprintable = 0;
	for (const byte of bytes) {
		if (byte === CR || byte === 0) return bytes;
		if (byte === LF) lf += 1;
		else if (
			byte === 0x7f ||
			(byte < 0x20 && !PRINTABLE_CONTROLS.has(byte))
		)
			nonprintable += 1;
		else printable += 1;
	}
	// Git does not count a trailing DOS end-of-file marker as binary.
	if (bytes[bytes.length - 1] === 0x1a) nonprintable -= 1;
	if (lf === 0 || printable >> 7 < nonprintable) return bytes;
	const out = new Uint8Array(bytes.length + lf);
	let at = 0;
	for (const byte of bytes) {
		if (byte === LF) out[at++] = CR;
		out[at++] = byte;
	}
	return out;
};

const gitBlobSha = (bytes: Uint8Array): string =>
	createHash("sha1")
		.update(`blob ${bytes.byteLength}\0`)
		.update(bytes)
		.digest("hex");

type TreeEntry = { path: string; mode: string; type: string; sha: string };

const isTreeEntry = (value: unknown): value is TreeEntry =>
	isRecord(value) &&
	typeof value.path === "string" &&
	typeof value.mode === "string" &&
	typeof value.type === "string" &&
	typeof value.sha === "string";

const githubHeaders = (env: NodeJS.ProcessEnv): Record<string, string> => {
	const token = env.GITHUB_TOKEN || env.GH_TOKEN;
	return {
		Accept: "application/vnd.github+json",
		"User-Agent": "neon-cli",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
};

const fetchTree = async (
	source: string,
	env: NodeJS.ProcessEnv,
): Promise<TreeEntry[]> => {
	const response = await fetch(
		`https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`,
		{
			headers: githubHeaders(env),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		},
	);
	if (!response.ok) {
		if (
			(response.status === 403 || response.status === 429) &&
			response.headers.get("x-ratelimit-remaining") === "0"
		) {
			throw new Error(
				`GitHub API rate limit reached while checking ${source}. Set GITHUB_TOKEN and retry.`,
			);
		}
		throw new Error(
			`GitHub returned ${response.status} for the file tree of ${source}.`,
		);
	}
	const body: unknown = await response.json();
	if (!isRecord(body) || !Array.isArray(body.tree)) {
		throw new Error(
			`GitHub returned an unexpected file tree for ${source}.`,
		);
	}
	if (body.truncated === true) {
		throw new Error(`GitHub truncated the file tree of ${source}.`);
	}
	return body.tree.filter(isTreeEntry);
};

/** The files the skills CLI hashes: regular files, outside `.git` and `node_modules`. */
const folderFiles = (tree: readonly TreeEntry[], folder: string) =>
	tree.filter((entry) => {
		if (entry.type !== "blob" || entry.mode === "120000") return false;
		if (!entry.path.startsWith(`${folder}/`)) return false;
		const dirs = entry.path
			.slice(folder.length + 1)
			.split("/")
			.slice(0, -1);
		return !dirs.includes(".git") && !dirs.includes("node_modules");
	});

const fetchContentHashes = async (
	source: string,
	folder: string,
	tree: readonly TreeEntry[],
): Promise<{ content: string; contentCrlf: string }> => {
	const files = await Promise.all(
		folderFiles(tree, folder).map(async (entry) => {
			const path = entry.path
				.split("/")
				.map(encodeURIComponent)
				.join("/");
			const response = await fetch(
				`https://raw.githubusercontent.com/${source}/HEAD/${path}`,
				{ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
			);
			if (!response.ok) {
				throw new Error(
					`GitHub returned ${response.status} for ${entry.path} in ${source}.`,
				);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (gitBlobSha(bytes) !== entry.sha) {
				throw new Error(`${source} changed during the check. Retry.`);
			}
			return { path: entry.path.slice(folder.length + 1), bytes };
		}),
	);
	return {
		content: skillContentHash(files),
		contentCrlf: skillContentHash(
			files.map((file) => ({
				...file,
				bytes: autocrlfCheckout(file.bytes),
			})),
		),
	};
};

type FolderRequest = { source: string; folder: string; content: boolean };

/**
 * The folders to fetch: the given skills, plus every folder already in the cache so
 * results for other directories stay current.
 */
const folderRequests = (
	skills: readonly LockedSkill[],
	previous: Record<string, RemoteFolder>,
): FolderRequest[] => {
	const requests = new Map<string, FolderRequest>();
	const add = (request: FolderRequest) => {
		const key = folderKey(request);
		const existing = requests.get(key);
		requests.set(key, {
			...request,
			content: request.content || existing?.content === true,
		});
	};
	for (const [key, remote] of Object.entries(previous)) {
		const split = key.lastIndexOf(":");
		const source = key.slice(0, split);
		if (split <= 0 || !NEON_SOURCES.has(source)) continue;
		add({
			source,
			folder: key.slice(split + 1),
			content: remote.content !== undefined,
		});
	}
	for (const skill of skills) {
		add({
			source: skill.source,
			folder: skill.folder,
			content: skill.hashKind === "content",
		});
	}
	return [...requests.values()];
};

/**
 * Fetches the default-branch state of every requested skill folder and writes it to the
 * cache. File contents are downloaded only for folders whose tree changed since the cache.
 */
export const refreshSkillsCheckCache = async ({
	cachePath,
	skills,
	env = process.env,
	now = Date.now(),
}: {
	cachePath: string;
	skills: readonly LockedSkill[];
	env?: NodeJS.ProcessEnv;
	now?: number;
}): Promise<Record<string, RemoteFolder>> => {
	const previous = readSkillsCheckCache(cachePath)?.folders ?? {};
	const requests = folderRequests(skills, previous);
	const folders: Record<string, RemoteFolder> = {};
	for (const source of new Set(requests.map((request) => request.source))) {
		const tree = await fetchTree(source, env);
		for (const request of requests) {
			if (request.source !== source) continue;
			const key = folderKey(request);
			const node = tree.find(
				(entry) =>
					entry.type === "tree" && entry.path === request.folder,
			);
			if (node === undefined) {
				folders[key] = { missing: true };
				continue;
			}
			const prior = previous[key];
			let hashes =
				prior?.tree === node.sha &&
				prior.content !== undefined &&
				prior.contentCrlf !== undefined
					? { content: prior.content, contentCrlf: prior.contentCrlf }
					: undefined;
			if (request.content && hashes === undefined) {
				hashes = await fetchContentHashes(source, request.folder, tree);
			}
			folders[key] = { tree: node.sha, ...hashes };
		}
	}
	writeJsonFile(cachePath, { checkedAt: now, folders }, "skills check cache");
	return folders;
};

export type SkillsStatusRow = {
	scope: string;
	skill: string;
	status: SkillStatus;
};

export const skillsStatusRows = (
	skills: readonly LockedSkill[],
	folders: Record<string, RemoteFolder>,
): SkillsStatusRow[] =>
	skills.map((skill) => {
		const status = skillStatus(skill, folders[folderKey(skill)]);
		if (status === undefined) {
			throw new Error(
				`No result for ${skill.skill} from ${skill.source}. Retry the check.`,
			);
		}
		return { scope: scopeLabel(skill.scope), skill: skill.skill, status };
	});

export const formatSkillsNotice = (
	outdated: readonly LockedSkill[],
): string | undefined => {
	if (outdated.length === 0) return undefined;
	const scopes = (["global", "project"] as const).filter((scope) =>
		outdated.some((skill) => skill.scope === scope),
	);
	return [
		"Neon agent skills have updates:",
		...scopes.map(
			(scope) =>
				`  ${scopeLabel(scope)}: ${outdated
					.filter((skill) => skill.scope === scope)
					.map((skill) => skill.skill)
					.join(", ")}`,
		),
		"Update them:",
		...scopes.map((scope) => `  ${neonSkillsUpdateCommand(scope)}`),
	].join("\n");
};

export type SkillsCheckPlan = {
	/** Skills to warn about. */
	outdated: LockedSkill[];
	/** Skills whose folders a background check should fetch now. */
	toCheck: LockedSkill[];
	refresh: boolean;
};

/**
 * `pending` folders are left alone until the next daily check. A lock written after the last
 * check (an install or an update) holds back the warning and checks every skill again,
 * because the cache can be older than what was just installed.
 */
export const planSkillsCheck = ({
	skills,
	cache,
	lockModifiedAt,
	now,
}: {
	skills: readonly LockedSkill[];
	cache: SkillsCheckCache | undefined;
	lockModifiedAt: number;
	now: number;
}): SkillsCheckPlan => {
	const remote = (skill: LockedSkill) => cache?.folders[folderKey(skill)];
	const settled = (skill: LockedSkill) => remote(skill)?.pending !== true;
	const lockChanged = cache !== undefined && lockModifiedAt > cache.checkedAt;
	const outdated = lockChanged
		? []
		: skills.filter(
				(skill) =>
					settled(skill) &&
					skillStatus(skill, remote(skill)) === "outdated",
			);
	const toCheck = skills.filter(
		(skill) =>
			settled(skill) &&
			(lockChanged || skillStatus(skill, remote(skill)) === undefined),
	);
	return {
		outdated,
		toCheck,
		refresh:
			cache === undefined ||
			toCheck.length > 0 ||
			now - (cache.attemptedAt ?? cache.checkedAt) >= DAY_MS,
	};
};

const spawnSkillsCheckWorker = (cachePath: string, cwd: string): void => {
	const workerPath = fileURLToPath(
		new URL("./check_worker.js", import.meta.url),
	);
	if (!existsSync(workerPath)) return;
	try {
		const child = spawn(process.execPath, [workerPath, cachePath, cwd], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", (error) => {
			log.debug("Skills check failed to start: %s", error.message);
		});
		child.unref();
	} catch (error) {
		log.debug(
			"Could not start the skills check: %s",
			error instanceof Error ? error.message : String(error),
		);
	}
};

type Lock = { skills: LockedSkill[]; modifiedAt: number };
type Locks = Record<SkillsScope, Lock>;

/** Every Neon skill in the lock, pinned ones included. */
const readLock = (path: string, scope: SkillsScope): Lock => ({
	skills: readAllLockedSkills(path, scope),
	modifiedAt: statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0,
});

const readLocks = (cwd: string): Locks => ({
	global: readLock(globalLockPath(), "global"),
	project: readLock(projectLockPath(cwd), "project"),
});

export type SkillsTelemetryScope =
	| { installed: false }
	| {
			installed: true;
			skills: Record<string, { hash: string; outdated: boolean | null }>;
	  };

/** The `skills` property on `cli_command_success`. */
export type SkillsTelemetry = {
	checkedAt: number | null;
	global: SkillsTelemetryScope;
	project: SkillsTelemetryScope;
};

/**
 * `outdated` is `null` when the cache cannot answer: no successful check yet, a check still
 * pending for the folder, a lock written after the last check, a folder gone upstream, or a
 * pinned skill.
 */
export const skillsTelemetry = (
	locks: Locks,
	cache: SkillsCheckCache | undefined,
): SkillsTelemetry => {
	const scope = ({ skills, modifiedAt }: Lock): SkillsTelemetryScope => {
		if (skills.length === 0) return { installed: false };
		const known =
			cache !== undefined &&
			cache.checkedAt > 0 &&
			modifiedAt <= cache.checkedAt;
		return {
			installed: true,
			skills: Object.fromEntries(
				skills.map((skill) => {
					const remote = cache?.folders[folderKey(skill)];
					const status =
						known && !skill.pinned && remote?.pending !== true
							? skillStatus(skill, remote)
							: undefined;
					return [
						skill.skill,
						{
							hash: skill.hash,
							outdated:
								status === "outdated"
									? true
									: status === "up to date"
										? false
										: null,
						},
					];
				}),
			),
		};
	};
	return {
		checkedAt:
			cache !== undefined && cache.checkedAt > 0 ? cache.checkedAt : null,
		global: scope(locks.global),
		project: scope(locks.project),
	};
};

/**
 * Reads only local files. `undefined` when a lock can't be read, which leaves the property
 * off the event rather than reporting skills as not installed.
 */
export const readSkillsTelemetry = ({
	configDir,
	cwd,
}: {
	configDir: string;
	cwd: string;
}): SkillsTelemetry | undefined => {
	try {
		return skillsTelemetry(
			readLocks(cwd),
			readSkillsCheckCache(skillsCheckCachePath(configDir)),
		);
	} catch (error) {
		log.debug(
			"Leaving skills out of telemetry: %s",
			error instanceof Error ? error.message : String(error),
		);
		return undefined;
	}
};

/**
 * Warns at most once a day when a Neon skill in the user-level lock or this directory's
 * `skills-lock.json` is behind its source, from a cache a background worker refreshes daily.
 */
export const notifyIfSkillsOutdated = ({
	configDir,
	cwd,
	now = Date.now(),
}: {
	configDir: string;
	cwd: string;
	now?: number;
}): void => {
	let locks: Locks;
	try {
		locks = readLocks(cwd);
	} catch (error) {
		log.debug(
			"Skipping the skills check: %s",
			error instanceof Error ? error.message : String(error),
		);
		return;
	}
	const skills = [...locks.global.skills, ...locks.project.skills].filter(
		(skill) => !skill.pinned,
	);
	if (skills.length === 0) return;

	const cachePath = skillsCheckCachePath(configDir);
	const cache = readSkillsCheckCache(cachePath);
	const plan = planSkillsCheck({
		skills,
		cache,
		lockModifiedAt: Math.max(
			locks.global.modifiedAt,
			locks.project.modifiedAt,
		),
		now,
	});
	const notice = formatSkillsNotice(plan.outdated);
	if (notice !== undefined) {
		showNotice({
			configDir,
			id: "skills",
			intervalMs: DAY_MS,
			message: notice,
			now,
		});
	}
	if (!plan.refresh) return;

	const folders = { ...cache?.folders };
	for (const skill of plan.toCheck) {
		folders[folderKey(skill)] = {
			...folders[folderKey(skill)],
			pending: true,
		};
	}
	if (
		writeJsonFile(
			cachePath,
			{ checkedAt: cache?.checkedAt ?? 0, attemptedAt: now, folders },
			"skills check cache",
		)
	) {
		spawnSkillsCheckWorker(cachePath, cwd);
	}
};
