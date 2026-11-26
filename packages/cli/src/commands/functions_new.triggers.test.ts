import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "@neon/config";
import { loadConfigFromFile } from "@neon/config-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editNeonConfig } from "../config_edit";
import { renderNeonConfig } from "../config_template";
import { planScaffold } from "../functions/scaffold";
import {
	DEFAULT_REGISTRY_URL,
	openRegistry,
	type Registry,
} from "../functions/source";
import { FIXTURE_REGISTRY_DIR } from "../test_utils/registry";
import {
	formatNewFunctionDone,
	type ScaffoldFromTemplateOptions,
	scaffoldFromTemplate,
	triggerJson,
} from "./functions_new";

const SCHEMA_URL = new URL("schemas/", DEFAULT_REGISTRY_URL).href;
const BRANCH = {
	name: "main",
	id: "br-main",
	exists: true,
	isDefault: true,
	isProtected: false,
	parentId: undefined,
	expiresAt: undefined,
};

const withBuckets = (...names: string[]) =>
	names.reduce(
		(source, name) =>
			editNeonConfig(source, { kind: "bucket", name, access: "private" })
				.source,
		renderNeonConfig([]),
	);

// The published template schema predates `triggers` and sets additionalProperties: false, so it
// would reject these fixtures. The CLI's own parser is what these tests exercise.
describe("functions new with template triggers", () => {
	let project: string;
	let registry: Registry;

	beforeEach(async () => {
		vi.stubGlobal("fetch", async (input: URL | string) => {
			const url = String(input);
			return url.startsWith(SCHEMA_URL)
				? new Response(JSON.stringify({ type: "object" }))
				: new Response("Not found\n", { status: 404 });
		});
		const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
		project = mkdtempSync(
			join(packageRoot, "node_modules", ".neon-functions-triggers-"),
		);
		writeFileSync(join(project, "neon.ts"), renderNeonConfig([]));
		registry = await openRegistry({
			kind: "dir",
			dir: FIXTURE_REGISTRY_DIR,
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(project, { recursive: true, force: true });
	});

	const read = () => readFileSync(join(project, "neon.ts"), "utf8");
	const run = async (
		options: Omit<ScaffoldFromTemplateOptions, "interactive">,
	) => {
		const result = await scaffoldFromTemplate({
			cwd: project,
			registry,
			interactive: false,
			install: false,
			...options,
		});
		if (result.cancelled) throw new Error("unexpected cancel");
		return result;
	};
	const resolvedTriggers = async () => {
		const { config } = await loadConfigFromFile({
			path: join(project, "neon.ts"),
		});
		return resolveConfig(config, BRANCH).triggers;
	};

	it("points a router template's triggers at the slug and the operation's route", async () => {
		writeFileSync(join(project, "neon.ts"), withBuckets("uploads"));

		const result = await run({ template: "uploads", slug: "media" });

		expect(result.triggers).toEqual([
			{
				name: "cleanup",
				type: "schedule",
				function: "media",
				cron: "0 * * * *",
				functionPath: "/cleanup",
				status: "added",
			},
			{
				name: "describe-uploads",
				type: "storage_object_created",
				function: "media",
				bucket: "uploads",
				prefix: "images/",
				functionPath: "/describe-image",
				status: "added",
			},
		]);
		expect(result.config?.changes).toEqual([
			"added functions.media",
			"added triggers.cleanup",
			"added triggers.describe-uploads",
		]);
		expect(read()).toContain(
			`  triggers: {
    cleanup: { type: "schedule", function: "media", cron: "0 * * * *", functionPath: "/cleanup" },
    "describe-uploads": { type: "storage_object_created", function: "media", bucket: "uploads", prefix: "images/", functionPath: "/describe-image" },
  },`,
		);
		expect(result.nextSteps.join("\n")).not.toContain("config add bucket");
		expect(await resolvedTriggers()).toEqual([
			{
				type: "schedule",
				name: "cleanup",
				functionSlug: "media",
				cron: "0 * * * *",
				functionPath: "/cleanup",
			},
			{
				type: "storage_object_created",
				name: "describe-uploads",
				functionSlug: "media",
				bucketName: "uploads",
				prefix: "images/",
				functionPath: "/describe-image",
			},
		]);
	});

	it("writes only the triggers of the operations it scaffolds", async () => {
		writeFileSync(join(project, "neon.ts"), withBuckets("uploads"));

		const result = await run({
			template: "uploads",
			operations: ["health", "cleanup"],
		});

		expect(result.triggers.map(({ name }) => name)).toEqual([
			"cleanup",
			"health-check",
		]);
		expect(read()).not.toContain("describe-uploads");
	});

	it("points a separate template's triggers at each operation's slug and path", async () => {
		writeFileSync(join(project, "neon.ts"), withBuckets("inbox"));

		await run({ template: "pipeline" });

		expect(await resolvedTriggers()).toEqual([
			{
				type: "storage_object_created",
				name: "ingest-files",
				functionSlug: "pipeingest",
				bucketName: "inbox",
				functionPath: "/",
			},
			{
				type: "schedule",
				name: "nightly-report",
				functionSlug: "pipereport",
				cron: "30 2 * * 1-5",
				functionPath: "/run",
			},
		]);
	});

	it("leaves functionPath out of neon.ts when it is /", async () => {
		writeFileSync(join(project, "neon.ts"), withBuckets("inbox"));

		const result = await run({ template: "ticker" });

		expect(read()).toContain(
			'tick: { type: "schedule", function: "ticker", cron: "0 * * * *", functionPath: "/__scheduled" },',
		);
		expect(read()).toContain(
			'"on-upload": { type: "storage_object_created", function: "ticker", bucket: "inbox" },',
		);
		expect(result.triggers[1]).not.toHaveProperty("functionPath");
		expect(formatNewFunctionDone(result)).toContain(
			"  Triggers   tick (cron 0 * * * *), on-upload (bucket inbox)\n",
		);
	});

	it("asks for the bucket instead of declaring it, and the file loads once it is", async () => {
		const result = await run({ template: "ticker" });

		expect(read()).not.toContain("buckets");
		expect(result.nextSteps).toContain(
			"Declare bucket inbox, which trigger on-upload watches: `neon config add bucket inbox`. neon.ts does not load until it is declared. Add `--access public_read` if the bucket allows anonymous reads.",
		);
		expect(result.next[0]).toBe("neon config add bucket inbox");
		await expect(resolvedTriggers()).rejects.toThrow(
			/references bucket "inbox", which is not declared/,
		);

		writeFileSync(
			join(project, "neon.ts"),
			editNeonConfig(read(), {
				kind: "bucket",
				name: "inbox",
				access: "private",
			}).source,
		);
		expect(await resolvedTriggers()).toHaveLength(2);
	});

	it("counts a bucket declared under preview as declared", async () => {
		writeFileSync(
			join(project, "neon.ts"),
			renderNeonConfig([]).replace(
				"export default defineConfig({\n",
				'export default defineConfig({\n  preview: {\n    buckets: { inbox: { access: "public_read" } },\n  },\n',
			),
		);

		const result = await run({ template: "ticker" });

		expect(result.nextSteps.join("\n")).not.toContain("config add bucket");
		expect(read()).toContain(
			'buckets: { inbox: { access: "public_read" } }',
		);
	});

	it("keeps a trigger neon.ts already declares and prints this template's to add by hand", async () => {
		const existing = editNeonConfig(withBuckets("inbox"), {
			kind: "trigger",
			name: "tick",
			type: "schedule",
			function: "other",
			cron: "5 4 * * *",
		}).source;
		writeFileSync(join(project, "neon.ts"), existing);

		const result = await run({ template: "ticker" });

		expect(read()).toContain(
			'tick: { type: "schedule", function: "other", cron: "5 4 * * *" },',
		);
		expect(result.config?.changes).toEqual([
			"added functions.ticker",
			"added triggers.on-upload",
		]);
		expect(result.triggers[0]).toMatchObject({
			name: "tick",
			status: "already_declared",
		});
		expect(result.nextSteps).toContain(
			'neon.ts already declares a trigger named tick, so it was left as it is. To add this template\'s trigger, declare it under triggers by hand, renaming the key to keep both: `tick: { type: "schedule", function: "ticker", cron: "0 * * * *", functionPath: "/__scheduled" },`',
		);
		expect(formatNewFunctionDone(result)).toContain(
			"tick (cron 0 * * * *, already declared)",
		);
	});

	it("prints a triggers create command for each trigger with --no-add-to-config", async () => {
		const result = await run({ template: "uploads", addToConfig: false });

		expect(read()).toBe(renderNeonConfig([]));
		expect(result.triggers.map(({ status }) => status)).toEqual([
			"not_added",
			"not_added",
		]);
		expect(result.next).toEqual(
			expect.arrayContaining([
				"neon triggers create --function-slug uploads --name cleanup --cron '0 * * * *' --function-path /cleanup",
				"neon triggers create --function-slug uploads --name describe-uploads --bucket uploads --prefix=images/ --function-path /describe-image",
			]),
		);
		expect(result.nextSteps.join("\n")).toContain(
			"create trigger describe-uploads (bucket uploads must exist on the branch first):",
		);
		const deploy = result.next.findIndex((line) =>
			line.startsWith("neon functions deploy"),
		);
		const create = result.next.findIndex((line) =>
			line.startsWith("neon triggers create"),
		);
		expect(deploy).toBeLessThan(create);
	});

	it("stays quiet about triggers it already wrote when rerun with --force", async () => {
		writeFileSync(join(project, "neon.ts"), withBuckets("inbox"));
		await run({ template: "ticker" });
		const written = read();

		const result = await run({ template: "ticker", force: true });

		expect(read()).toBe(written);
		expect(result.triggers.map(({ status }) => status)).toEqual([
			"already_declared",
			"already_declared",
		]);
		expect(result.nextSteps.join("\n")).not.toContain(
			"already declares a trigger",
		);
	});

	it("counts a reformatted copy of the template's trigger as the same declaration", async () => {
		writeFileSync(
			join(project, "neon.ts"),
			editNeonConfig(withBuckets("inbox"), {
				kind: "trigger",
				name: "tick",
				type: "schedule",
				function: "ticker",
				cron: "0 * * * *",
				functionPath: "/__scheduled",
			}).source.replace(
				'tick: { type: "schedule", function: "ticker", cron: "0 * * * *", functionPath: "/__scheduled" },',
				'tick: {\n      type: "schedule",\n      function: "ticker",\n      cron: "0 * * * *",\n      functionPath: "/__scheduled",\n    },',
			),
		);

		const result = await run({ template: "ticker" });

		expect(result.triggers[0]).toMatchObject({
			status: "already_declared",
		});
		expect(result.nextSteps.join("\n")).not.toContain(
			"already declares a trigger",
		);
	});

	it("passes --config through to the bucket command", async () => {
		const result = await run({ template: "ticker", config: "neon.ts" });

		expect(result.next[0]).toBe(
			"neon config add bucket inbox --config neon.ts",
		);
	});

	it.each([
		[
			"buckets set to an expression",
			"const shared = {};\n\nexport default defineConfig({\n  buckets: shared,\n",
		],
		[
			"buckets declared under preview without this bucket",
			'export default defineConfig({\n  preview: {\n    buckets: { other: { access: "private" } },\n  },\n',
		],
	])("asks to check the bucket by hand when neon config add bucket cannot edit %s", async (_, header) => {
		writeFileSync(
			join(project, "neon.ts"),
			renderNeonConfig([]).replace(
				"export default defineConfig({\n",
				header,
			),
		);

		const result = await run({ template: "ticker" });

		expect(result.nextSteps.join("\n")).not.toContain(
			"config add bucket inbox",
		);
		expect(result.nextSteps).toContain(
			'Make sure neon.ts declares bucket inbox, which trigger on-upload watches. neon.ts does not load until it does, and `neon config add bucket` cannot edit this file\'s buckets, so add it by hand if it is missing: `inbox: { access: "private" },` (`access: "public_read"` if the bucket allows anonymous reads).',
		);
		expect(result.next[0]).toBe(
			'Add to buckets in neon.ts if missing: inbox: { access: "private" },',
		);
	});

	it("refuses a separate template whose operation slug is not a valid function slug", async () => {
		const entry = registry.entries.find(({ id }) => id === "pipeline");
		if (!entry) throw new Error("missing pipeline fixture");
		const loaded = await registry.load(entry);
		const operations = (loaded.template.operations ?? []).map(
			(operation, index) =>
				index === 0
					? { ...operation, slug: "pipe ingest; rm" }
					: operation,
		);

		expect(() =>
			planScaffold(
				{ ...loaded, template: { ...loaded.template, operations } },
				operations,
				"pipeline",
			),
		).toThrow(
			/Template "pipeline" gives operation "ingest" the invalid function slug "pipe ingest; rm"/,
		);
	});

	it("names functionPath function_path in JSON output", async () => {
		writeFileSync(join(project, "neon.ts"), withBuckets("inbox"));

		const result = await run({ template: "ticker" });

		expect(result.triggers.map(triggerJson)).toEqual([
			{
				name: "tick",
				type: "schedule",
				function: "ticker",
				cron: "0 * * * *",
				function_path: "/__scheduled",
				status: "added",
			},
			{
				name: "on-upload",
				type: "storage_object_created",
				function: "ticker",
				bucket: "inbox",
				status: "added",
			},
		]);
	});
});
