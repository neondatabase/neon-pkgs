import { describe, expect, it } from "vitest";
import {
	allowGithubTemplateSources,
	parseRegistryIndex,
	type RegistryIndexDocument,
	remoteSourceJsonSchema,
	type SchemaValidate,
} from "./registry";

const permissive: SchemaValidate<RegistryIndexDocument> = {
	check: (data): data is RegistryIndexDocument => true,
	errorsText: () => "",
};

const index = (source: unknown) =>
	JSON.stringify({
		templates: [
			{
				id: "partner",
				title: "P",
				description: "d",
				path: "t.json",
				source,
			},
		],
	});

describe("allowGithubTemplateSources", () => {
	const schema = (properties: Record<string, unknown>) => ({
		properties: { templates: { items: { properties } } },
	});

	it("adds source to a schema that lacks it without changing the original", () => {
		const published = schema({ id: { type: "string" } });
		expect(allowGithubTemplateSources(published)).toEqual(
			schema({ id: { type: "string" }, source: remoteSourceJsonSchema }),
		);
		expect(published).toEqual(schema({ id: { type: "string" } }));
	});

	it("keeps a source the published schema already defines", () => {
		const published = schema({ source: { type: "object" } });
		expect(allowGithubTemplateSources(published)).toEqual(published);
	});
});

describe("parseRegistryIndex source", () => {
	it("marks a source shape this CLI cannot read instead of failing the index", () => {
		for (const source of [
			{ gitlab: { project: "a/b" } },
			{ github: { owner: "workos", repo: "neon-sync", sha: "abc" } },
			{ github: { owner: "workos", repo: "neon-sync" }, mirror: "x" },
		]) {
			const [entry] = parseRegistryIndex(index(source), permissive);
			expect(entry).toMatchObject({
				id: "partner",
				unsupportedSource: true,
			});
			expect(entry).not.toHaveProperty("source");
		}
	});

	it("still rejects an unsafe value in a known GitHub shape", () => {
		expect(() =>
			parseRegistryIndex(
				index({
					github: { owner: "workos", repo: "neon-sync", dir: "../x" },
				}),
				permissive,
			),
		).toThrow(/invalid source\.github\.dir/);
		expect(() =>
			parseRegistryIndex(
				index({ github: { owner: "workos", repo: "..", ref: "main" } }),
				permissive,
			),
		).toThrow(/invalid source\.github\.repo/);
	});

	it("rejects a GitHub source with a missing or non-string field", () => {
		for (const [source, field] of [
			[{ github: { owner: "workos" } }, /invalid source\.github\.repo/],
			[
				{ github: { owner: "workos", repo: "neon-sync", ref: 1 } },
				/invalid source\.github\.ref/,
			],
			[{ github: "workos/neon-sync" }, /invalid source\.github\./],
			[{}, /invalid source\./],
			[null, /invalid source\./],
		] as const) {
			expect(() => parseRegistryIndex(index(source), permissive)).toThrow(
				field,
			);
		}
	});
});
