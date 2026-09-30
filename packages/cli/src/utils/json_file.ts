import { renameSync, rmSync, writeFileSync } from "node:fs";
import { log } from "../log.js";

/** Renames a temporary file into place so a concurrent reader never sees a partial write. */
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
