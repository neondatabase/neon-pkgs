import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	downloadGithubTemplate,
	type GithubDownloadOptions,
	type GithubTemplateSource,
	type TemplateFile,
	validateTemplateFiles,
} from "./github.js";

export class TemplateInputError extends Error {
	readonly agentCode: string;

	constructor(message: string, agentCode: string) {
		super(message);
		this.name = "TemplateInputError";
		this.agentCode = agentCode;
	}
}

/**
 * Ensure a target is missing or empty (apart from a lone `.git`). `force`
 * permits other contents and colliding files.
 */
export const ensureTargetUsable = (dir: string, force: boolean): void => {
	if (!existsSync(dir)) return;
	if (!statSync(dir).isDirectory()) {
		throw new TemplateInputError(
			`Target ${dir} already exists and is not a directory.`,
			"TARGET_NOT_DIRECTORY",
		);
	}
	const contents = readdirSync(dir).filter((name) => name !== ".git");
	if (contents.length > 0 && !force) {
		throw new TemplateInputError(
			`Target directory ${dir} is not empty. Use --force to scaffold into it anyway (colliding files will be overwritten), or choose an empty directory.`,
			"TARGET_NOT_EMPTY",
		);
	}
};

const isSymlink = (path: string): boolean => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};

const errnoCode = (error: unknown): string | undefined => {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
	) {
		return error.code;
	}
	return undefined;
};

const assertContained = (root: string, destination: string): void => {
	const fromRoot = relative(root, destination);
	if (
		fromRoot === "" ||
		fromRoot === ".." ||
		fromRoot.startsWith(`..${sep}`) ||
		isAbsolute(fromRoot)
	) {
		throw new Error(
			`Template path escapes the target directory: "${destination}".`,
		);
	}
};

const assertNoSymlinkParents = (root: string, destination: string): void => {
	const segments = relative(root, dirname(destination)).split(sep);
	let current = root;
	for (const segment of segments) {
		if (segment === "" || segment === ".") continue;
		current = resolve(current, segment);
		if (isSymlink(current)) {
			throw new Error(
				`Refusing to write through existing symlink "${current}".`,
			);
		}
	}
};

const writeSymlink = (
	destination: string,
	target: string,
	onWarn?: (message: string) => void,
): void => {
	if (existsSync(destination) || isSymlink(destination)) {
		if (lstatSync(destination).isDirectory()) {
			throw new Error(
				`Cannot replace directory "${destination}" with a template symlink.`,
			);
		}
		rmSync(destination, { force: true });
	}
	try {
		symlinkSync(target, destination);
	} catch (error) {
		if (errnoCode(error) === "EPERM" || process.platform === "win32") {
			onWarn?.(
				`Could not create symlink ${destination} -> ${target}; wrote it as a regular file instead.`,
			);
			writeFileSync(destination, target);
			return;
		}
		throw error;
	}
};

export type MaterializeOptions = {
	onWarn?: (message: string) => void;
};

/**
 * Materialize a previously validated template file set. Existing symlink
 * ancestors and symlink destinations are never followed.
 */
export const materializeTemplateFiles = (
	files: readonly TemplateFile[],
	targetDir: string,
	options: MaterializeOptions = {},
): number => {
	validateTemplateFiles(files);
	if (existsSync(targetDir) && isSymlink(targetDir)) {
		throw new Error(
			`Template target must not be a symlink: "${targetDir}".`,
		);
	}
	mkdirSync(targetDir, { recursive: true });
	const root = realpathSync(targetDir);

	for (const file of files) {
		const destination = resolve(root, ...file.path.split("/"));
		assertContained(root, destination);
		assertNoSymlinkParents(root, destination);
		mkdirSync(dirname(destination), { recursive: true });

		if (file.kind === "symlink") {
			writeSymlink(destination, file.target, options.onWarn);
		} else {
			if (isSymlink(destination)) rmSync(destination, { force: true });
			writeFileSync(destination, file.bytes);
			if (file.executable) chmodSync(destination, 0o755);
		}
	}
	return files.length;
};

export type ScaffoldGithubTemplateOptions = MaterializeOptions &
	GithubDownloadOptions;

export const scaffoldGithubTemplate = async (
	source: GithubTemplateSource,
	targetDir: string,
	options: ScaffoldGithubTemplateOptions = {},
): Promise<number> => {
	const files = await downloadGithubTemplate(source, options);
	return materializeTemplateFiles(files, targetDir, options);
};
