import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Owner read/write. A credential needs those two and nothing else. */
export const SECRET_FILE_MODE = 0o600;

/**
 * Write a secret to disk owner-only, by creating a temporary file in the same directory and
 * renaming it over the target.
 *
 * The rename is what makes this correct rather than merely tidy. `writeFileSync`'s `mode`
 * applies only when it *creates* the file, so writing over an existing credentials file
 * leaves whatever permissions it already had — a file created `0700` by an older release
 * stays `0700` forever, and one created before a umask change stays world-readable. Renaming
 * a fresh inode into place means every write lands at {@link SECRET_FILE_MODE}, so the
 * permissions repair themselves instead of being inherited.
 *
 * It also closes the window where a reader could see the file at default permissions: the
 * temporary file is created `0600` *before* it holds the secret's final name, and `rename`
 * is atomic within a directory, so there is no moment at which the target is readable by
 * anyone else and no moment at which it is half-written.
 *
 * The temporary name carries the pid so two processes writing at once cannot collide on it.
 */
export const writeSecretFile = (path: string, contents: string): void => {
	const directory = dirname(path);
	const temporary = join(
		directory,
		`.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
	);
	try {
		writeFileSync(temporary, contents, {
			encoding: "utf8",
			mode: SECRET_FILE_MODE,
		});
		renameSync(temporary, path);
	} catch (err) {
		// Never leave the secret behind under a temporary name the caller doesn't know about.
		try {
			unlinkSync(temporary);
		} catch {
			// The temp file was never created, or is already gone. Report the original error.
		}
		throw err;
	}
};
