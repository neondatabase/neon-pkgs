import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Editor-autocomplete tests for `parseEnv`'s second argument, driven through the same
 * TypeScript language service an editor uses.
 *
 * `env.test-d.ts` proves the *types* are sound (an undeclared function slug is rejected), but
 * type soundness and autocomplete are separate behaviours: the completion list for a
 * half-typed string literal comes from the **first candidate overload**, so simply reordering
 * `parseEnv`'s overloads silently empties it while every type test keeps passing. That
 * regression already shipped once — a `parseEnv(config, "…")` slug offered no completions
 * because the `keys` array overload was listed first — hence these assertions.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Marks the caret position in a fixture; stripped before the file is handed to the LS. */
const CARET = "/*|*/";

/** Virtual fixture path. Lives next to `env.ts` so its relative import resolves normally. */
const FIXTURE = resolve(here, "__completions_fixture.ts");

const tsconfigPath = resolve(here, "../../tsconfig.json");
const tsconfig = ts.parseJsonConfigFileContent(
	ts.readConfigFile(tsconfigPath, ts.sys.readFile).config,
	ts.sys,
	dirname(tsconfigPath),
);

/**
 * Resolve `@neon/config/v1` to the sibling package's TypeScript **source** instead of its
 * built `dist/`, for the same reason `vitest.config.ts` aliases it: the package `exports`
 * point at `dist/`, so without this the completions asserted here would come from a
 * potentially **stale** build of `config` (CI installs but never builds it).
 */
const compilerOptions: ts.CompilerOptions = {
	...tsconfig.options,
	baseUrl: here,
	paths: {
		"@neon/config/v1": [resolve(here, "../../../config/src/v1.ts")],
		"@neon-internals/env-core/env": [
			resolve(here, "../../../../internals/env-core/src/env.ts"),
		],
	},
};

let fixtureText = "";
let fixtureVersion = 0;

const host: ts.LanguageServiceHost = {
	getScriptFileNames: () => [FIXTURE],
	getScriptVersion: (fileName) =>
		fileName === FIXTURE ? String(fixtureVersion) : "1",
	getScriptSnapshot: (fileName) => {
		if (fileName === FIXTURE) {
			return ts.ScriptSnapshot.fromString(fixtureText);
		}
		const contents = ts.sys.readFile(fileName);
		return contents === undefined
			? undefined
			: ts.ScriptSnapshot.fromString(contents);
	},
	getCurrentDirectory: () => here,
	getCompilationSettings: () => compilerOptions,
	getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
	fileExists: (fileName) =>
		fileName === FIXTURE ? true : ts.sys.fileExists(fileName),
	readFile: (fileName, encoding) =>
		fileName === FIXTURE
			? fixtureText
			: ts.sys.readFile(fileName, encoding),
	readDirectory: ts.sys.readDirectory,
	directoryExists: ts.sys.directoryExists,
	getDirectories: ts.sys.getDirectories,
	realpath: ts.sys.realpath,
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());

/**
 * The completions an editor would offer at the {@link CARET} marker in `source`, sorted so
 * assertions don't depend on the language service's ordering.
 */
function completionsAt(source: string): string[] {
	const caret = source.indexOf(CARET);
	if (caret === -1) throw new Error(`fixture has no ${CARET} marker`);
	fixtureText = source.replace(CARET, "");
	fixtureVersion += 1;
	const completions = service.getCompletionsAtPosition(FIXTURE, caret, {
		includeCompletionsWithInsertText: true,
	});
	return (completions?.entries ?? []).map((entry) => entry.name).sort();
}

/** A policy declaring two functions, plus whichever extra services a case needs. */
function fixture(configBody: string, call: string): string {
	return [
		'import { defineConfig } from "@neon/config/v1";',
		'import { parseEnv } from "./parse-env.js";',
		"",
		`const config = defineConfig(${configBody});`,
		"",
		`export const env = ${call};`,
		"",
	].join("\n");
}

/** A fixture that reaches `fetchEnv` through the package's public entry point. */
function fetchFixture(configBody: string, call: string): string {
	return [
		'import { defineConfig } from "@neon/config/v1";',
		'import { fetchEnv } from "../index.js";',
		"",
		`const config = defineConfig(${configBody});`,
		"",
		`export const env = ${call};`,
		"",
	].join("\n");
}

const TWO_FUNCTIONS = `{
	preview: {
		functions: {
			hello: { name: "Hello", source: "./hello.ts", env: { resendApiKey: "" } },
			world: { name: "World", source: "./world.ts" },
		},
	},
}`;

describe("parseEnv autocomplete", () => {
	// The *first* query is what builds the program behind the language service (`env.ts` plus
	// `@neon/config`'s source, zod's declarations and the TypeScript lib files); every query
	// after it reuses that program and is quick. Locally the build takes a few hundred ms, but
	// on a cold CI runner under coverage instrumentation it ran past Vitest's 5s default and
	// failed the first test on time rather than on its result. Pay the cost once here, with a
	// hook timeout sized for the slowest runner, so the assertions below time only themselves.
	beforeAll(() => {
		completionsAt(fixture("{}", `parseEnv(config, "${CARET}")`));
	}, 120_000);

	test("offers the policy's declared function slugs", () => {
		const entries = completionsAt(
			fixture(TWO_FUNCTIONS, `parseEnv(config, "${CARET}")`),
		);
		expect(entries).toEqual(["hello", "world"]);
	});

	test("offers the env-var keys of exactly the policy's namespaces", () => {
		const entries = completionsAt(
			fixture(
				`{ auth: true, ${TWO_FUNCTIONS.slice(1)}`,
				`parseEnv(config, ["${CARET}"])`,
			),
		);
		// Postgres + auth only: no storage / AI Gateway keys, since the policy enables neither.
		expect(entries).toEqual([
			"DATABASE_URL",
			"DATABASE_URL_UNPOOLED",
			"NEON_AUTH_BASE_URL",
			"NEON_AUTH_JWKS_URL",
			"NEON_BRANCH",
		]);
	});

	test("offers policy-scoped keys through fetchEnv's public package export", () => {
		const entries = completionsAt(
			fetchFixture(
				`{ auth: true, ${TWO_FUNCTIONS.slice(1)}`,
				`fetchEnv(config, {
					projectId: "proj",
					branch: "main",
					keys: ["${CARET}"],
				})`,
			),
		);
		expect(entries).toEqual([
			"DATABASE_URL",
			"DATABASE_URL_UNPOOLED",
			"NEON_AUTH_BASE_URL",
			"NEON_AUTH_JWKS_URL",
			"NEON_BRANCH",
		]);
	});

	test("explains itself when the policy declares no functions", () => {
		const entries = completionsAt(
			fixture("{ auth: true }", `parseEnv(config, "${CARET}")`),
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatch(/declares no .?preview\.functions/);
	});
});
