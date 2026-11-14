import { describe, expect, it } from "vitest";
import {
	allowGithubTemplateSources,
	allowTemplateAgentTooling,
	parseRegistryIndex,
	parseTemplateItem,
	type RegistryIndexDocument,
	remoteSourceJsonSchema,
	type SchemaValidate,
	type TemplateDocument,
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

describe("template agent tooling", () => {
	const anyTemplate: SchemaValidate<TemplateDocument> = {
		check: (data): data is TemplateDocument => true,
		errorsText: () => "",
	};
	const template = (agent: unknown) =>
		JSON.stringify({
			id: "stripe",
			title: "Stripe",
			description: "d",
			layout: "router",
			agent,
		});

	it("admits agent in a published schema that closes its properties", () => {
		const published = {
			additionalProperties: false,
			properties: { id: { type: "string" } },
		};
		expect(allowTemplateAgentTooling(published)).toEqual({
			additionalProperties: false,
			properties: { id: { type: "string" }, agent: { type: "object" } },
		});
		expect(published.properties).not.toHaveProperty("agent");
	});

	it("parses a valid agent block onto the template", () => {
		const parsed = parseTemplateItem(
			template({
				mcp: [{ name: "stripe", url: "https://mcp.stripe.com" }],
			}),
			anyTemplate,
		);
		expect(parsed.agent?.mcp[0]).toMatchObject({
			kind: "remote",
			name: "stripe",
		});
	});

	it("rejects the template when its agent block is invalid", () => {
		expect(() =>
			parseTemplateItem(
				template({ mcp: [{ name: "Neon", url: "https://x.dev" }] }),
				anyTemplate,
			),
		).toThrow(/Invalid template.json for "stripe": agent.mcp\[0\].name/);
	});

	it("leaves templates without an agent block unchanged", () => {
		expect(
			parseTemplateItem(template(undefined), anyTemplate),
		).not.toHaveProperty("agent");
	});
});
