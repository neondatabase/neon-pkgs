/**
 * Type-checks a built package the way a consumer compiles it: every `exports` subpath is
 * imported by package name and `tsc` runs with `skipLibCheck: false`, so errors inside the
 * emitted `.d.ts` files fail the check. `attw` only verifies resolution and passed on
 * `@neon/sdk` 2.x–6.1.1, whose `raw.d.ts` referenced an undeclared `raw_d_exports`.
 *
 * Usage: node scripts/check-dist-types.mjs packages/<dir>
 */

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageDir = process.argv[2];
if (!packageDir) {
	console.error("usage: node scripts/check-dist-types.mjs packages/<dir>");
	process.exit(2);
}

const root = resolve(packageDir);
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const subpaths = manifest.exports
	? Object.entries(manifest.exports)
			.filter(
				([subpath, target]) =>
					!subpath.includes("*") &&
					subpath !== "./package.json" &&
					typeof target === "object" &&
					target !== null &&
					"types" in target,
			)
			.map(([subpath]) => subpath)
	: manifest.types
		? ["."]
		: [];

if (subpaths.length === 0) {
	console.error(
		`${manifest.name}: no "exports" entry with a "types" condition and no top-level "types"`,
	);
	process.exit(1);
}

// Self-referencing by name needs an `exports` map; without one, import the `types` file.
const specifiers = manifest.exports
	? subpaths.map((subpath) =>
			subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
		)
	: [`./${manifest.types.replace(/^\.\//, "").replace(/\.d\.ts$/, ".js")}`];

// Self-references resolve only from inside the package's own directory.
const consumerFile = join(root, ".dist-types-check.mts");
writeFileSync(
	consumerFile,
	`${specifiers.map((specifier, i) => `import * as entry${i} from "${specifier}";`).join("\n")}\nexport { ${specifiers.map((_, i) => `entry${i}`).join(", ")} };\n`,
);

try {
	execFileSync(
		"tsc",
		[
			"--noEmit",
			"--strict",
			"--skipLibCheck",
			"false",
			"--module",
			"nodenext",
			"--moduleResolution",
			"nodenext",
			"--target",
			"es2022",
			"--types",
			"node",
			consumerFile,
		],
		{ cwd: root, stdio: "inherit" },
	);
} catch {
	console.error(
		`\n${manifest.name}: published type declarations do not compile for a consumer (${specifiers.join(", ")})`,
	);
	process.exitCode = 1;
} finally {
	rmSync(consumerFile, { force: true });
}

if (process.exitCode !== 1) {
	console.log(`${manifest.name}: declarations compile for ${specifiers.join(", ")}`);
}
