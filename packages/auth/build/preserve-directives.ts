import type { Plugin, RenderedChunk } from "rolldown";

/**
 * Options for the preserveDirectives plugin
 */
export type PreserveDirectivesOptions = {
	/**
	 * List of packages that are known to be client-only.
	 * If a chunk imports from any of these packages, 'use client' will be added.
	 */
	clientPackages?: string[];
};

/** Maximum lines to scan for directives (they must be at the top) */
const MAX_DIRECTIVE_LINES = 10;

/** Supported directives */
const DIRECTIVES = ["use client", "use server"] as const;

/**
 * Check if code contains an import from any of the specified packages.
 */
function hasImportFrom(code: string, packages: string[]): boolean {
	for (const pkg of packages) {
		// Simple string matching - faster and safer than regex
		if (code.includes(`from '${pkg}'`) || code.includes(`from "${pkg}"`)) {
			return true;
		}
	}
	return false;
}

/**
 * Check if a line contains a directive statement.
 * Matches: 'use client'; | "use client"; | 'use client' | "use client"
 */
function parseDirective(line: string): string | null {
	const trimmed = line.trim();
	for (const directive of DIRECTIVES) {
		const patterns = [
			`'${directive}';`,
			`"${directive}";`,
			`'${directive}'`,
			`"${directive}"`,
		];
		if (patterns.includes(trimmed)) {
			return directive;
		}
	}
	return null;
}

/**
 * A Rolldown plugin that preserves 'use client' and 'use server' directives.
 *
 * Why this exists:
 * - tsdown/rolldown strips directives during bundling
 * - React Server Components require these directives at the top of files
 * - This plugin detects directives in source files and re-adds them to output chunks
 *
 * How it works:
 * 1. transform hook: Scans each source file for directives and clientPackage imports
 * 2. Stores findings in a Map keyed by module ID
 * 3. renderChunk hook: Collects directives for all modules in the chunk
 * 4. Prepends directive statements to the output chunk
 */
export function preserveDirectives(
	options: PreserveDirectivesOptions = {},
): Plugin {
	const { clientPackages = [] } = options;

	// Track which modules have which directives
	const moduleDirectives = new Map<string, Set<string>>();

	return {
		name: "preserve-directives",

		transform: {
			order: "post", // Run after TypeScript transpilation
			handler(code: string, id: string) {
				// Skip node_modules - external deps handled by renderChunk fallback
				if (id.includes("node_modules")) {
					return null;
				}

				const directives = new Set<string>();

				// Scan first N lines for directives
				const lines = code.split("\n").slice(0, MAX_DIRECTIVE_LINES);
				for (const line of lines) {
					const directive = parseDirective(line);
					if (directive) {
						directives.add(directive);
					}
				}

				// Check for imports from known client packages
				if (
					clientPackages.length > 0 &&
					hasImportFrom(code, clientPackages)
				) {
					directives.add("use client");
				}

				if (directives.size > 0) {
					moduleDirectives.set(id, directives);
				}

				return null; // Don't modify code in transform
			},
		},

		renderChunk(code: string, chunk: RenderedChunk) {
			const chunkDirectives = new Set<string>();

			// Collect directives from all modules in this chunk
			for (const moduleId of Object.keys(chunk.modules)) {
				moduleDirectives.get(moduleId)?.forEach((d) => {
					chunkDirectives.add(d);
				});
			}

			// Also check the entry point module
			if (chunk.facadeModuleId) {
				moduleDirectives.get(chunk.facadeModuleId)?.forEach((d) => {
					chunkDirectives.add(d);
				});
			}

			// Fallback: If no directives found via Map lookup, scan the chunk code directly.
			// This catches edge cases like virtual modules or bundler-restructured code
			// where the module ID might not match what we saw in transform.
			if (
				clientPackages.length > 0 &&
				chunkDirectives.size === 0 &&
				hasImportFrom(code, clientPackages)
			) {
				chunkDirectives.add("use client");
			}

			if (chunkDirectives.size === 0) {
				return null;
			}

			// Prepend directives to the chunk
			const directiveStatements = [...chunkDirectives]
				.map((d) => `'${d}';`)
				.join("\n");

			return {
				code: `${directiveStatements}\n${code}`,
				map: null,
			};
		},
	};
}
