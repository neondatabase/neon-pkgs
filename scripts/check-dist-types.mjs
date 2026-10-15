/**
 * Type-checks a built package the way a consumer compiles it: every `exports` subpath is
 * imported by package name and `tsc` runs with `skipLibCheck: false`, so errors inside the
 * emitted `.d.ts` files fail the check. `attw` only verifies resolution and passed on
 * `@neon/sdk` 2.x–6.1.1, whose `raw.d.ts` referenced an undeclared `raw_d_exports`.
 *
 * `import * as` never names a symbol, so a declaration file whose `export { x as c }` list does
 * not match the real export names still compiles. `--named-exports` also imports every runtime
 * export of each subpath by name, which fails with TS2460 on such files.
 *
 * Usage: node scripts/check-dist-types.mjs packages/<dir> [--named-exports]
 */

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [packageDir, ...flags] = process.argv.slice(2);
const namedExports = flags.includes("--named-exports");
if (!packageDir) {
	console.error(
		"usage: node scripts/check-dist-types.mjs packages/<dir> [--named-exports]",
	);
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

const namedImports = [];
if (namedExports && manifest.exports) {
	for (const [i, subpath] of subpaths.entries()) {
		const target = manifest.exports[subpath].default;
		const runtime = await import(pathToFileURL(join(root, target)).href);
		const names = Object.keys(runtime).filter((name) => name !== "default");
		if (names.length > 0) {
			namedImports.push(
				`import { ${names.map((name) => `${name} as n${i}_${name}`).join(", ")} } from "${specifiers[i]}";`,
				`export { ${names.map((name) => `n${i}_${name}`).join(", ")} };`,
			);
		}
	}
}

// Self-references resolve only from inside the package's own directory.
const consumerFile = join(root, ".dist-types-check.mts");
writeFileSync(
	consumerFile,
	`${specifiers.map((specifier, i) => `import * as entry${i} from "${specifier}";`).join("\n")}\nexport { ${specifiers.map((_, i) => `entry${i}`).join(", ")} };\n${namedImports.join("\n")}\n`,
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
