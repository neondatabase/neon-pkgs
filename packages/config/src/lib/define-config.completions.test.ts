import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, test } from "vitest";

// Autocomplete regression guard for the nested `preview.functions` / `preview.buckets` slug
// objects (see `PreviewAutocomplete` in `define-config.ts`).
//
// This can't be expressed with `expectTypeOf`: the *resolved* contextual type already exposed
// the right keys before the fix — the bug lived only in the editor's completion provider,
// where a named slug property on the inferred `const Preview` literal shadowed the
// `Record<string, FunctionDef>` index signature. So we drive the real TypeScript language
// service and assert on the member completions it returns at a marked cursor position.

// Each test boots a full TypeScript language service over the package's source. That is
// inherently CPU-heavy and gets markedly slower under `--coverage` instrumentation and CI
// parallelism, so the default 5s timeout is too tight. Give them generous headroom.
const LANGUAGE_SERVICE_TIMEOUT_MS = 30_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(HERE, "..", "..");
// A virtual file living in `src/lib` so its `./define-config.js` import resolves to the real
// source module under the project's module resolution.
const FIXTURE = resolve(HERE, "__completions_fixture__.ts");

let parsedOptions: ts.ParsedCommandLine;

beforeAll(() => {
	const configPath = ts.findConfigFile(
		PKG_DIR,
		ts.sys.fileExists,
		"tsconfig.json",
	);
	if (!configPath) throw new Error("tsconfig.json not found");
	const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
	parsedOptions = ts.parseJsonConfigFileContent(
		config,
		ts.sys,
		dirname(configPath),
	);
});

/**
 * Return the *member* completions the language service offers at the `/*|*\/` marker in
 * `source`. Filters out keyword/global-scope fallbacks so the list reflects the contextual
 * object type (an empty list means "no object members were offered" — the bug we guard).
 */
function memberCompletionsAt(source: string): string[] {
	const marker = "/*|*/";
	const position = source.indexOf(marker);
	if (position < 0) throw new Error("missing /*|*/ marker in fixture source");
	const text = source.replace(marker, "");

	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => [FIXTURE, ...parsedOptions.fileNames],
		getScriptVersion: () => "1",
		getScriptSnapshot: (fileName) =>
			fileName === FIXTURE
				? ts.ScriptSnapshot.fromString(text)
				: (() => {
						const content = ts.sys.readFile(fileName);
						return content === undefined
							? undefined
							: ts.ScriptSnapshot.fromString(content);
					})(),
		getCurrentDirectory: () => PKG_DIR,
		getCompilationSettings: () => parsedOptions.options,
		getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
		fileExists: (f) => f === FIXTURE || ts.sys.fileExists(f),
		readFile: (f) => (f === FIXTURE ? text : ts.sys.readFile(f)),
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
	};

	const service = ts.createLanguageService(host, ts.createDocumentRegistry());
	const info = service.getCompletionsAtPosition(FIXTURE, position, {
		includeCompletionsForModuleExports: false,
		triggerKind: ts.CompletionTriggerKind.Invoked,
	});
	// `isGlobalCompletion` is true when TS found no object contextual type and fell back to
	// in-scope identifiers; treat that as "no member completions" so the bug can't hide behind
	// thousands of global names that happen to include a matching word.
	if (!info || info.isGlobalCompletion) return [];
	return info.entries
		.filter((e) => e.kind !== "keyword" && e.kind !== "warning")
		.map((e) => e.name);
}

describe("preview slug-object autocomplete (language service)", () => {
	test(
		"an empty function slug object offers every FunctionDef member",
		() => {
			const completions = memberCompletionsAt(`
import { defineConfig } from "./define-config.js";
export default defineConfig({
	preview: { functions: { hello: { /*|*/ } } },
});
`);
			expect(completions).toEqual(
				expect.arrayContaining(["name", "source", "env", "dev"]),
			);
		},
		LANGUAGE_SERVICE_TIMEOUT_MS,
	);

	test(
		"a partial function slug object still offers the remaining members",
		() => {
			const completions = memberCompletionsAt(`
import { defineConfig } from "./define-config.js";
export default defineConfig({
	preview: {
		functions: {
			hello: { name: "Hello", source: "./hello.ts", /*|*/ },
		},
	},
});
`);
			expect(completions).toEqual(expect.arrayContaining(["env", "dev"]));
			// name/source are already present, so they are (correctly) not re-offered.
			expect(completions).not.toContain("name");
		},
		LANGUAGE_SERVICE_TIMEOUT_MS,
	);

	test(
		"a bucket slug object offers the BucketDef members",
		() => {
			const completions = memberCompletionsAt(`
import { defineConfig } from "./define-config.js";
export default defineConfig({
	preview: { buckets: { uploads: { /*|*/ } } },
});
`);
			expect(completions).toContain("access");
		},
		LANGUAGE_SERVICE_TIMEOUT_MS,
	);

	test(
		"the top-level preview object still offers its members",
		() => {
			const completions = memberCompletionsAt(`
import { defineConfig } from "./define-config.js";
export default defineConfig({
	preview: { /*|*/ },
});
`);
			expect(completions).toEqual(
				expect.arrayContaining(["aiGateway", "functions", "buckets"]),
			);
		},
		LANGUAGE_SERVICE_TIMEOUT_MS,
	);
});
