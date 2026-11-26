import { describe, expect, it } from "vitest";
import {
	allowGithubTemplateSources,
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
const anyTemplate: SchemaValidate<TemplateDocument> = {
	check: (data): data is TemplateDocument => true,
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

describe("parseTemplateItem triggers", () => {
	const operation = (id: string, extra: object = {}) => ({
		id,
		title: id,
		description: "d",
		source: `functions/${id}.ts`,
		recommended: true,
		...extra,
	});
	const parse = (triggers: unknown, template: Record<string, unknown> = {}) =>
		parseTemplateItem(
			JSON.stringify({
				id: "jobs",
				title: "Jobs",
				description: "d",
				layout: "router",
				operations: [operation("cleanup"), operation("describe")],
				...template,
				triggers,
			}),
			anyTemplate,
		);
	const cleanup = {
		name: "cleanup",
		type: "schedule",
		cron: "0 * * * *",
		operation: "cleanup",
	};

	it("parses schedule and storage triggers", () => {
		expect(
			parse([
				cleanup,
				{
					name: "describe-uploads",
					type: "storage_object_created",
					bucket: "uploads",
					prefix: "images/",
					operation: "describe",
				},
			]).triggers,
		).toEqual([
			cleanup,
			{
				name: "describe-uploads",
				type: "storage_object_created",
				bucket: "uploads",
				prefix: "images/",
				operation: "describe",
			},
		]);
	});

	it("defaults to no triggers", () => {
		expect(parse(undefined).triggers).toEqual([]);
	});

	it.each([
		["a non-array", { cleanup }, /triggers must be an array/],
		["an unknown type", [{ ...cleanup, type: "cron" }], /has a type other/],
		[
			"a field the type does not take",
			[{ ...cleanup, bucket: "uploads" }],
			/has a field schedule triggers do not take/,
		],
		[
			"an uppercase name",
			[{ ...cleanup, name: "Cleanup" }],
			/needs a name/,
		],
		[
			"a 64-character name",
			[{ ...cleanup, name: "a".repeat(64) }],
			/needs a name/,
		],
		["a repeated name", [cleanup, cleanup], /triggers\[1\] repeats a name/],
		[
			"six cron fields",
			[{ ...cleanup, cron: "0 0 * * * *" }],
			/five-field cron/,
		],
		[
			"a named cron field",
			[{ ...cleanup, cron: "0 0 * * MON" }],
			/five-field cron/,
		],
		["a cron macro", [{ ...cleanup, cron: "@hourly" }], /five-field cron/],
		[
			"doubled cron spaces",
			[{ ...cleanup, cron: "0  * * * *" }],
			/five-field cron/,
		],
		[
			"a short bucket name",
			[
				{
					name: "x",
					type: "storage_object_created",
					bucket: "ab",
					operation: "cleanup",
				},
			],
			/needs a bucket name/,
		],
		[
			"a 64-character bucket name",
			[
				{
					name: "x",
					type: "storage_object_created",
					bucket: "a".repeat(64),
					operation: "cleanup",
				},
			],
			/needs a bucket name/,
		],
		[
			"an empty prefix",
			[
				{
					name: "x",
					type: "storage_object_created",
					bucket: "uploads",
					prefix: "",
					operation: "cleanup",
				},
			],
			/needs a prefix/,
		],
		[
			"a prefix with a terminal escape",
			[
				{
					name: "x",
					type: "storage_object_created",
					bucket: "uploads",
					prefix: "images/\u001b[2J",
					operation: "cleanup",
				},
			],
			/needs a prefix of 1-1024 UTF-8 bytes with no control characters/,
		],
		[
			"a prefix with a C1 control character",
			[
				{
					name: "x",
					type: "storage_object_created",
					bucket: "uploads",
					prefix: "images/\u009b",
					operation: "cleanup",
				},
			],
			/no control characters/,
		],
		[
			"a prefix of 1024 characters but more than 1024 bytes",
			[
				{
					name: "x",
					type: "storage_object_created",
					bucket: "uploads",
					prefix: "é".repeat(513),
					operation: "cleanup",
				},
			],
			/needs a prefix of 1-1024 UTF-8 bytes/,
		],
		[
			"a cron field starting with a hyphen",
			[{ ...cleanup, cron: "-5 * * * *" }],
			/each field starting with a digit or \*/,
		],
		[
			"a missing operation",
			[{ ...cleanup, operation: undefined }],
			/needs the operation it calls/,
		],
		[
			"an unknown operation",
			[{ ...cleanup, operation: "nope" }],
			/names an operation the template lacks/,
		],
		[
			"a path on a router operation",
			[{ ...cleanup, path: "/x" }],
			/router trigger posts to its operation's route/,
		],
	])("rejects %s", (_label, triggers, message) => {
		expect(() => parse(triggers)).toThrow(message);
	});

	it("rejects an operation on a template without operations", () => {
		expect(() => parse([cleanup], { operations: undefined })).toThrow(
			/sets an operation, but the template has no operations/,
		);
	});

	it("takes a path on a separate operation and on a template without operations", () => {
		const separate = parse([{ ...cleanup, path: "/__scheduled" }], {
			layout: "separate",
			operations: [operation("cleanup", { slug: "cleanup" })],
		});
		expect(separate.triggers[0]).toMatchObject({ path: "/__scheduled" });

		const single = parse(
			[
				{
					name: "tick",
					type: "schedule",
					cron: "*/5 0-6 1,15 * 1-5",
					path: "/",
				},
			],
			{ operations: undefined },
		);
		expect(single.triggers[0]).toMatchObject({ path: "/" });
	});

	it.each([
		"__scheduled",
		"/a b",
		'/"x',
		"/\u001b[2J",
		`/${"a".repeat(2048)}`,
	])("rejects the path %s", (path) => {
		expect(() =>
			parse(
				[{ name: "tick", type: "schedule", cron: "0 * * * *", path }],
				{
					operations: undefined,
				},
			),
		).toThrow(/has a path that is not a URL path/);
	});

	it.each([
		"/run?mode=full&dry=1",
		"/files/%20report",
		`/${"a".repeat(2047)}`,
	])("takes the path %s", (path) => {
		const { triggers } = parse(
			[{ name: "tick", type: "schedule", cron: "0 * * * *", path }],
			{ operations: undefined },
		);
		expect(triggers[0]).toMatchObject({ path });
	});

	it("takes a prefix of exactly 1024 bytes", () => {
		const prefix = "é".repeat(512);
		const { triggers } = parse([
			{
				name: "x",
				type: "storage_object_created",
				bucket: "uploads",
				prefix,
				operation: "cleanup",
			},
		]);
		expect(triggers[0]).toMatchObject({ prefix });
	});
});
