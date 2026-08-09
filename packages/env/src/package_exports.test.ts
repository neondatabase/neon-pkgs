import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDir = fileURLToPath(new URL("../dist", import.meta.url));

/** Every emitted `.js` file, or a failure saying the build has to run first. */
const emittedFiles = (): string[] => {
	if (!existsSync(distDir)) {
		throw new Error(
			`No ${distDir}. This spec asserts what the built package exposes, so run ` +
				"`pnpm --filter @neon/env build` before it.",
		);
	}
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((entry) => {
			const path = join(dir, entry);
			return statSync(path).isDirectory() ? walk(path) : [path];
		});
	return walk(distDir).filter((path) => path.endsWith(".js"));
};

/**
 * `@neon/env` bundles `@neon-internals/*` in, and the only thing making that happen is `external`
 * in `tsdown.config.ts`. If that predicate drifts, `dist/index.js` ships
 * `import … from "@neon-internals/env-core/env"` and every `npm i @neon/env` fails on the root
 * import — the package's whole surface, for a config typo. `packages/cli` pins the same invariant
 * for `neon`; nothing else pins it here.
 */
describe("the built package", () => {
	it("resolves the private internals at build time, never at runtime", () => {
		// Anchored to the start of a line, because rolldown keeps JSDoc blocks and the internals
		// document themselves with `import … from "@neon-internals/…"` examples. A comment naming
		// the specifier is not an import of it. Side-effect imports have no `from`.
		const importsInternals =
			/^\s*(?:import|export)\b[^'"`]*?from\s*["']@neon-internals\/|^\s*import\s*["']@neon-internals\/|\bimport\s*\(\s*["']@neon-internals\//m;
		const leaking = emittedFiles().filter((path) =>
			importsInternals.test(readFileSync(path, "utf8")),
		);
		expect(leaking).toEqual([]);
	});

	it("declares the internals' code rather than importing it", () => {
		// `fetchEnv` originates in `@neon-internals/env-core`, so its declaration appearing in
		// this package's own output is what "bundled in" means.
		const declaresIt = emittedFiles().filter((path) =>
			/\b(?:function|const|let|var|class)\s+fetchEnv\b/.test(
				readFileSync(path, "utf8"),
			),
		);
		expect(declaresIt).not.toEqual([]);
	});

	it("keeps the published type surface on one `Config`", () => {
		// The declaration bundler will inline a copy of `@neon/config`'s types if the internals
		// stop marking it external, and then the exported generics are parameterized over the
		// copy while `parseEnv` uses the import. A consumer sees `Config$1` on hover and in every
		// mismatch error, naming a type they cannot look up.
		const types = readFileSync(join(distDir, "index.d.ts"), "utf8");
		expect(types).toMatch(
			/^import \{[^}]*\bConfig\b[^}]*\} from "@neon\/config\/v1";/m,
		);
		expect(types).not.toMatch(/\bConfig\$\d/);
	});
});
