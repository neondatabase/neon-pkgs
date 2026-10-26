import { pathToFileURL } from "node:url";
import {
	globalLockPath,
	projectLockPath,
	readLockedSkills,
	refreshSkillsCheckCache,
} from "./freshness.js";

const run = async (): Promise<void> => {
	const [cachePath, cwd] = process.argv.slice(2);
	if (cachePath === undefined || cwd === undefined) return;

	try {
		await refreshSkillsCheckCache({
			cachePath,
			skills: [
				...readLockedSkills(globalLockPath(), "global"),
				...readLockedSkills(projectLockPath(cwd), "project"),
			],
		});
	} catch {
		// The check is advisory and must not affect the command that launched it.
	}
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	void run();
}
