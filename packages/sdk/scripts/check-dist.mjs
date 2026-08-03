/**
 * Fails the build when `dist/` is not publishable. See `dist-guard.mjs` for what is
 * checked and why.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDist } from "./dist-guard.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { name, fileCount, problems } = await inspectDist(packageRoot);

if (problems.length > 0) {
	console.error(`\n${name}: dist/ is not publishable\n`);
	for (const problem of problems) console.error(`  • ${problem}`);
	console.error("");
	process.exit(1);
}

console.log(
	`${name}: dist/ is clean — ${fileCount} files, no bundled or external dependencies and no test artifacts.`,
);
