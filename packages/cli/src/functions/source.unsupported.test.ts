import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRegistry } from "./source";

vi.mock("./registry", async (importOriginal) => {
	const original = await importOriginal<typeof import("./registry")>();
	return {
		...original,
		allowGithubTemplateSources: (schema: object) => {
			const published = structuredClone(schema) as {
				properties: {
					templates: {
						items: { properties: Record<string, unknown> };
					};
				};
			};
			published.properties.templates.items.properties.source = {};
			return original.allowGithubTemplateSources(published);
		},
	};
});

describe("openRegistry with a source this CLI does not know", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "neon-registry-unsupported-"));
		writeFileSync(
			join(dir, "registry.json"),
			JSON.stringify({
				templates: [
					{
						id: "partner",
						title: "Partner",
						description: "d",
						path: "template.json",
						categories: ["partner"],
						source: { gitlab: { project: "workos/neon-sync" } },
					},
				],
			}),
		);
	});

	afterEach(() => {
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
	});
});
