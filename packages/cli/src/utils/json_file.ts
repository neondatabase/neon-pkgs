import { renameSync, rmSync, writeFileSync } from "node:fs";
import { log } from "../log.js";

/**
 * Replace `path` with `value` as JSON, readable only by the user. Writing a temporary file
 * and renaming it means a concurrent reader sees the old file or the new one, never half of
 * one. Returns false, after a debug log naming `description`, when the write fails.
 */
export const writeJsonFile = (
	path: string,
	value: unknown,
	description: string,
): boolean => {
	const temporaryPath = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
			mode: 0o600,
		});
		renameSync(temporaryPath, path);
		return true;
	} catch (error) {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {}
		log.debug(
			"Could not write the %s: %s",
			description,
			error instanceof Error ? error.message : String(error),
		);
		return false;
	}
};
