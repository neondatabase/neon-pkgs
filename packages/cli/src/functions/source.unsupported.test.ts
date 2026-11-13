import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REGISTRY_URL, openRegistry } from "./source";

const futureRegistrySchema = {
	type: "object",
	required: ["templates"],
	properties: {
		templates: {
			type: "array",
			items: {
				type: "object",
				required: ["id", "title", "description", "path"],
				properties: {
					source: {
						type: "object",
						oneOf: [
							{ required: ["github"] },
							{ required: ["gitlab"] },
						],
					},
				},
			},
		},
	},
};
const SCHEMA_URL = new URL("schemas/", DEFAULT_REGISTRY_URL).href;
const EXAMPLES_URL = "https://examples.test/registry.json";
const GITHUB_RAW = "https://raw.test";

const entryFor = (id: string) => ({
	id,
	title: id,
	description: "d",
	path: `${id}/template.json`,
	categories: ["partner"],
});
const futureEntry = (id: string) => ({
	...entryFor(id),
	source: { gitlab: { project: "workos/neon-sync" } },
});

describe("openRegistry with a source this CLI does not know", () => {
	let dir: string;
	let fetched: string[];

	beforeEach(() => {
		fetched = [];
		const routes: Record<string, unknown> = {
			[`${SCHEMA_URL}registry.schema.json`]: futureRegistrySchema,
			[`${SCHEMA_URL}template.schema.json`]: { type: "object" },
			[`${GITHUB_RAW}/acme/registry/main/registry.json`]: {
				templates: [],
			},
			[EXAMPLES_URL]: {
				templates: [entryFor("demo"), futureEntry("partner")],
			},
		};
		vi.stubGlobal("fetch", async (input: URL | string) => {
			const url = String(input);
			fetched.push(url);
			const body = routes[url];
			return body === undefined
				? new Response("Not found\n", { status: 404 })
				: new Response(JSON.stringify(body));
		});
		dir = mkdtempSync(join(tmpdir(), "neon-registry-unsupported-"));
		writeFileSync(
			join(dir, "registry.json"),
			JSON.stringify({ templates: [futureEntry("partner")] }),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists the template and asks for a newer CLI when it is picked", async () => {
		const registry = await openRegistry({ kind: "dir", dir });
		const [entry] = registry.entries;
		expect(entry).toMatchObject({ id: "partner", unsupportedSource: true });
		if (!entry) throw new Error("partner entry did not parse");
		await expect(registry.load(entry)).rejects.toThrow(
			/Template "partner" needs a newer version of the neon CLI\. Update the CLI and retry\./,
		);
		expect(fetched).toContain(`${SCHEMA_URL}registry.schema.json`);
		expect(fetched.every((url) => url.startsWith(SCHEMA_URL))).toBe(true);
	});

	it("drops the template from the examples registry", async () => {
		const registry = await openRegistry(undefined, {
			primary: EXAMPLES_URL,
			fallback: EXAMPLES_URL,
			neonRegistry: { owner: "acme", repo: "registry", ref: "main" },
			githubRaw: GITHUB_RAW,
			env: {},
		});
		expect(registry.entries.map((entry) => entry.id)).toEqual(["demo"]);
	});
});
