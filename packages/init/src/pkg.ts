import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load this package's package.json for version metadata by walking up from this
 * module to the nearest one. That resolves to the same file whether the code is
 * running bundled from `dist/` or straight from `src/` under tsx or Vitest, so
 * `pkg.version` is correct everywhere without a test-only shim.
 *
 * `package.json` is in the package's published `files`, so this also resolves
 * for an installed copy.
 */
const loadPkg = (): { name: string; version: string } => {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		try {
			return JSON.parse(
				readFileSync(join(dir, "package.json"), "utf-8"),
			) as {
				name: string;
				version: string;
			};
		} catch {
			const parent = dirname(dir);
			if (parent === dir) {
				throw new Error(
					"Could not locate package.json for version detection.",
				);
			}
			dir = parent;
		}
	}
};

export default loadPkg();
