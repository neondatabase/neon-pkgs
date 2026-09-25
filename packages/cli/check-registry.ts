import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BUILTIN_TEMPLATES,
	isContainedRelativePath,
	parseRegistryIndex,
	parseTemplateItem,
	REGISTRY_CONTRACT,
} from "./src/functions/registry.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const registryDir = join(repoRoot, "registry");

const errors: string[] = [];
const fail = (message: string): void => {
	errors.push(message);
};

const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
};

const rejects = (label: string, item: unknown): void => {
	try {
		parseTemplateItem(JSON.stringify(item));
		fail(`parser accepted an invalid template (${label})`);
	} catch {}
};

const checkParserContract = (): void => {
	const base = { id: "demo", title: "Demo", description: "d" };
	const router = parseTemplateItem(
		JSON.stringify({
			...base,
			layout: "router",
			operations: [
				{
					id: "a",
					title: "A",
					description: "d",
					source: "functions/a.ts",
					route: "/a",
					recommended: true,
				},
			],
		}),
	);
	if (router.layout !== "router") fail("router template lost its layout");
	const separate = parseTemplateItem(
		JSON.stringify({
			...base,
			layout: "separate",
			operations: [
				{
					id: "a",
					title: "A",
					description: "d",
					source: "functions/a.ts",
					slug: "aa",
					recommended: true,
				},
			],
		}),
	);
	if (separate.operations?.[0]?.slug !== "aa") {
		fail("separate template dropped its operation slug");
	}
	rejects("missing layout", { ...base, operations: [] });
	rejects("separate without slug", {
		...base,
		layout: "separate",
		operations: [
			{
				id: "a",
				title: "A",
				description: "d",
				source: "functions/a.ts",
				recommended: true,
			},
		],
	});
	rejects("bad route", {
		...base,
		layout: "router",
		operations: [
			{
				id: "a",
				title: "A",
				description: "d",
				source: "functions/a.ts",
				route: "bad",
				recommended: true,
			},
		],
	});
	rejects("escaping source", {
		...base,
		layout: "separate",
		operations: [
			{
				id: "a",
				title: "A",
				description: "d",
				source: "../evil.ts",
				slug: "aa",
				recommended: true,
			},
		],
	});
};

const normalize = (pattern: unknown): string =>
	typeof pattern === "string" ? pattern.replace(/\\\//g, "/") : "";

const checkSchemaDrift = (): void => {
	const schemaPath = join(registryDir, "schemas", "template.schema.json");
	if (!existsSync(schemaPath)) return;
	const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
	const props = schema.properties ?? {};
	const op = props.operations?.items ?? {};
	const opProps = op.properties ?? {};
	const eq = (label: string, actual: unknown, expected: unknown): void => {
		if (stable(actual) !== stable(expected)) {
			fail(
				`schema drift: ${label} (schema ${stable(actual)} vs parser ${stable(expected)})`,
			);
		}
	};
	eq(
		"template required",
		schema.required,
		REGISTRY_CONTRACT.requiredTemplateFields,
	);
	eq("layout enum", props.layout?.enum, REGISTRY_CONTRACT.layouts);
	eq(
		"operation required",
		op.required,
		REGISTRY_CONTRACT.requiredOperationFields,
	);
	const pattern = (label: string, actual: unknown, re: RegExp): void => {
		if (normalize(actual) !== normalize(re.source)) {
			fail(`schema drift: ${label} pattern`);
		}
	};
	pattern("template id", props.id?.pattern, REGISTRY_CONTRACT.templateId);
	pattern("operation id", opProps.id?.pattern, REGISTRY_CONTRACT.operationId);
	pattern(
		"operation slug",
		opProps.slug?.pattern,
		REGISTRY_CONTRACT.operationSlug,
	);
	pattern("operation route", opProps.route?.pattern, REGISTRY_CONTRACT.route);
	pattern(
		"env name",
		props.environment?.items?.properties?.name?.pattern,
		REGISTRY_CONTRACT.envName,
	);
	if (props.operations?.maxItems !== REGISTRY_CONTRACT.maxOperations) {
		fail("schema drift: operations maxItems");
	}
	const conditional = (schema.allOf ?? []).some(
		(rule: {
			if?: { properties?: { layout?: { const?: string } } };
			then?: {
				properties?: {
					operations?: { items?: { required?: string[] } };
				};
			};
		}) =>
			rule?.if?.properties?.layout?.const === "separate" &&
			rule?.then?.properties?.operations?.items?.required?.includes(
				"slug",
			),
	);
	if (!conditional) fail("schema drift: missing separate→slug requirement");
};

const checkCanonicalContent = (): void => {
	const indexPath = join(registryDir, "registry.json");
	if (!existsSync(indexPath)) return;
	const index = parseRegistryIndex(readFileSync(indexPath, "utf8"));
	for (const entry of index) {
		if (!entry.path) continue;
		if (!isContainedRelativePath(entry.path)) {
			fail(`index path escapes the registry: ${entry.path}`);
			continue;
		}
		const itemPath = join(registryDir, entry.path);
		if (!existsSync(itemPath)) {
			fail(`missing template.json for "${entry.id}": ${entry.path}`);
			continue;
		}
		const template = parseTemplateItem(
			readFileSync(itemPath, "utf8"),
			entry.id,
		);
		const itemDir = dirname(itemPath);
		for (const operation of template.operations ?? []) {
			if (!isContainedRelativePath(operation.source)) {
				fail(
					`${entry.id}: operation source escapes: ${operation.source}`,
				);
				continue;
			}
			if (!existsSync(join(itemDir, operation.source))) {
				fail(
					`${entry.id}: missing operation source ${operation.source}`,
				);
			}
		}
		const builtin = BUILTIN_TEMPLATES.find(
			(candidate) => candidate.template.id === entry.id,
		);
		if (!builtin) continue;
		if (stable(builtin.template) !== stable(template)) {
			fail(
				`${entry.id}: bundled built-in metadata drifted from template.json`,
			);
		}
		for (const [relativePath, source] of Object.entries(builtin.sources)) {
			const filePath = join(itemDir, relativePath);
			if (
				!existsSync(filePath) ||
				readFileSync(filePath, "utf8") !== source
			) {
				fail(
					`${entry.id}: bundled source ${relativePath} drifted from disk`,
				);
			}
		}
	}
};

checkParserContract();
checkSchemaDrift();
checkCanonicalContent();

if (errors.length > 0) {
	process.stderr.write(
		`Registry contract check failed:\n${errors.map((error) => `  - ${error}`).join("\n")}\n`,
	);
	process.exit(1);
}
process.stdout.write(
	`${
		existsSync(join(registryDir, "registry.json"))
			? "Registry contract check passed (parser, schema, and local registry/)."
			: "Registry contract check passed (parser + schema; registry/ not present)."
	}\n`,
);
