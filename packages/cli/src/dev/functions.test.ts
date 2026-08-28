import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveFunctionsFromConfig } from "./functions.js";

/**
 * Write a neon.ts and the function source files it references into a temp dir, so
 * resolveFunctionsFromConfig (which loads + resolves the policy and checks each source
 * exists on disk) runs against a realistic layout.
 */
const writeWorkspace = (
	cwd: string,
	neonTs: string,
	sources: string[],
): void => {
	writeFileSync(join(cwd, "neon.ts"), neonTs);
	for (const rel of sources) {
		writeFileSync(
			join(cwd, rel),
			'export default { fetch: () => new Response("ok") };\n',
		);
	}
};

describe("resolveFunctionsFromConfig", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neonctl-dev-fns-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns null when there is no neon.ts", async () => {
		await expect(resolveFunctionsFromConfig(cwd)).resolves.toBeNull();
	});

	it("returns an empty list when neon.ts declares no functions", async () => {
		writeWorkspace(cwd, "export default {};\n", []);
		const resolved = await resolveFunctionsFromConfig(cwd);
		expect(resolved?.functions).toEqual([]);
		expect(resolved?.configPath).toBe(join(cwd, "neon.ts"));
	});

	it("mirrors externalPackages so a local bundle matches a deploy", async () => {
		writeWorkspace(
			cwd,
			`export default {
        preview: {
          functions: {
            hello: {
              name: 'Hello',
              source: './hello.ts',
              externalPackages: ['microsandbox'],
            },
            bare: { name: 'Bare', source: './bare.ts' },
          },
        },
      };\n`,
			["hello.ts", "bare.ts"],
		);

		const resolved = await resolveFunctionsFromConfig(cwd);
		const bySlug = new Map(resolved?.functions.map((f) => [f.slug, f]));
		expect(bySlug.get("hello")?.externalPackages).toEqual(["microsandbox"]);
		// Absent, not empty, when the policy does not declare it.
		expect(bySlug.get("bare")).not.toHaveProperty("externalPackages");
	});

	// Locally both forms mean the same thing — leave it unbundled — so the plan carries
	// names only. `includeFiles` governs the deployed archive, which `neon dev` never builds.
	it("flattens both entry forms to names", async () => {
		writeWorkspace(
			cwd,
			`export default {
        preview: {
          functions: {
            resize: {
              name: 'Resize',
              source: './resize.ts',
              externalPackages: ['sharp', { name: 'canvas', includeFiles: false }],
            },
            bare: { name: 'Bare', source: './bare.ts' },
          },
        },
      };\n`,
			["resize.ts", "bare.ts"],
		);

		const resolved = await resolveFunctionsFromConfig(cwd);
		const bySlug = new Map(resolved?.functions.map((f) => [f.slug, f]));
		expect(bySlug.get("resize")?.externalPackages).toEqual([
			"sharp",
			"canvas",
		]);
		// Absent, not empty, when the policy does not declare it.
		expect(bySlug.get("bare")).not.toHaveProperty("externalPackages");
	});

	it("resolves each function with an absolute source and its dev settings", async () => {
		writeWorkspace(
			cwd,
			`export default {
        preview: {
          functions: {
            hello: { name: 'Hello', source: './hello.ts', dev: { port: 8788 } },
            bare: { name: 'Bare', source: './bare.ts' },
          },
        },
      };\n`,
			["hello.ts", "bare.ts"],
		);

		const resolved = await resolveFunctionsFromConfig(cwd);
		expect(resolved).not.toBeNull();
		expect(resolved?.configPath).toBe(join(cwd, "neon.ts"));
		const fns = resolved?.functions;
		const bySlug = Object.fromEntries((fns ?? []).map((f) => [f.slug, f]));

		// Explicit `dev.port` is carried through.
		expect(bySlug.hello).toMatchObject({
			slug: "hello",
			name: "Hello",
			source: join(cwd, "hello.ts"),
			port: 8788,
		});
		// No `dev.port`: the supervisor searches for a free port, so none is set here.
		expect(bySlug.bare.port).toBeUndefined();
	});

	it("throws when a declared function source does not exist on disk", async () => {
		writeWorkspace(
			cwd,
			`export default {
        preview: { functions: { gone: { name: 'Gone', source: './missing.ts' } } },
      };\n`,
			[],
		);
		await expect(resolveFunctionsFromConfig(cwd)).rejects.toThrow(
			/source that does not exist/,
		);
	});

	it("carries per-function env through", async () => {
		writeWorkspace(
			cwd,
			`export default {
        preview: {
          functions: {
            e: { name: 'E', source: './e.ts', env: { FOO: 'bar' } },
          },
        },
      };\n`,
			["e.ts"],
		);
		const resolved = await resolveFunctionsFromConfig(cwd);
		expect(resolved?.functions[0].env).toEqual({ FOO: "bar" });
	});

	it("mirrors a none bundler and accepts a directory source", async () => {
		mkdirSync(join(cwd, "build-output"), { recursive: true });
		writeFileSync(
			join(cwd, "build-output", "index.mjs"),
			'export default { fetch: () => new Response("ok") };\n',
		);
		writeFileSync(
			join(cwd, "neon.ts"),
			`export default {
        preview: {
          functions: {
            app: {
              name: 'App',
              source: './build-output',
              bundler: 'none',
            },
          },
        },
      };\n`,
		);

		const resolved = await resolveFunctionsFromConfig(cwd);
		expect(resolved?.functions[0]).toMatchObject({
			slug: "app",
			source: join(cwd, "build-output"),
			bundler: "none",
		});
	});

	it("omits bundler for the esbuild default so the common path is unchanged", async () => {
		writeWorkspace(
			cwd,
			`export default {
        preview: { functions: { hello: { name: 'Hello', source: './hello.ts' } } },
      };\n`,
			["hello.ts"],
		);
		const resolved = await resolveFunctionsFromConfig(cwd);
		expect(resolved?.functions[0]).not.toHaveProperty("bundler");
	});
});
