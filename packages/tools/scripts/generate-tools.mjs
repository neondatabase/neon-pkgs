import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, "../../sdk/spec/neon-openapi.json");
const outPath = resolve(here, "../src/operations.gen.ts");
const zodPath = resolve(here, "../src/generated/zod.gen.ts");
const document = JSON.parse(readFileSync(specPath, "utf8"));
const httpMethods = new Set([
	"delete",
	"get",
	"head",
	"options",
	"patch",
	"post",
	"put",
	"trace",
]);

const approvalRequiredReads = new Set([
	"getConnectionURI",
	"getProjectBranchRolePassword",
]);

const resolveReference = (reference) => {
	if (!reference.startsWith("#/")) {
		throw new Error(`Unsupported external OpenAPI reference: ${reference}`);
	}
	return reference
		.slice(2)
		.split("/")
		.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
		.reduce((value, part) => value?.[part], document);
};

const dereference = (value) => {
	let current = value;
	const seen = new Set();
	while (current?.$ref) {
		if (seen.has(current.$ref)) {
			throw new Error(`Circular OpenAPI reference: ${current.$ref}`);
		}
		seen.add(current.$ref);
		current = resolveReference(current.$ref);
	}
	return current;
};

const pascalCase = (value) => value[0].toUpperCase() + value.slice(1);

const camelCase = (value) => {
	const words =
		value.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g)?.map((word) =>
			word.toLowerCase(),
		) ?? [];
	if (words.length === 0) {
		throw new Error(`Cannot convert OpenAPI operationId to camelCase: ${value}`);
	}
	return [
		words[0],
		...words.slice(1).map((word) => pascalCase(word)),
	].join("");
};

const snakeCase = (value) =>
	value
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z\d])([A-Z])/g, "$1_$2")
		.replaceAll("-", "_")
		.toLowerCase();

const requestBodySchema = (requestBody) => {
	const body = dereference(requestBody);
	if (!body?.content) return undefined;
	const mediaType =
		body.content["application/json"] ??
		body.content["multipart/form-data"] ??
		Object.values(body.content)[0];
	return mediaType?.schema;
};

const collectBinaryPaths = (schema, path = [], references = new Set()) => {
	if (!schema) return [];
	if (schema.$ref) {
		if (references.has(schema.$ref)) return [];
		const nextReferences = new Set(references);
		nextReferences.add(schema.$ref);
		return collectBinaryPaths(
			resolveReference(schema.$ref),
			path,
			nextReferences,
		);
	}
	if (schema.type === "string" && schema.format === "binary") {
		return [{ path, required: true }];
	}

	const resolved = dereference(schema);
	const required = new Set(resolved?.required ?? []);
	const paths = [];
	for (const [name, property] of Object.entries(resolved?.properties ?? {})) {
		for (const binary of collectBinaryPaths(property, [...path, name], references)) {
			paths.push({
				path: binary.path,
				required: required.has(name) && binary.required,
			});
		}
	}
	for (const child of [
		...(resolved?.allOf ?? []),
		...(resolved?.anyOf ?? []),
		...(resolved?.oneOf ?? []),
	]) {
		paths.push(...collectBinaryPaths(child, path, references));
	}
	if (resolved?.items) {
		paths.push(...collectBinaryPaths(resolved.items, [...path, "[]"], references));
	}
	return paths;
};

const resolveParameters = (parameters = []) =>
	parameters.map((parameter) => dereference(parameter));

const operationRecords = [];
const operationIds = new Set();
const toolIds = new Set();

for (const [path, pathItemValue] of Object.entries(document.paths ?? {})) {
	const pathItem = dereference(pathItemValue);
	const pathParameters = resolveParameters(pathItem.parameters);
	for (const [method, operationValue] of Object.entries(pathItem)) {
		if (!httpMethods.has(method)) continue;
		const operation = dereference(operationValue);
		if (!operation.operationId) {
			throw new Error(`Missing operationId for ${method.toUpperCase()} ${path}`);
		}
		if (operationIds.has(operation.operationId)) {
			throw new Error(`Duplicate OpenAPI operationId: ${operation.operationId}`);
		}
		operationIds.add(operation.operationId);

		const toolId = snakeCase(operation.operationId);
		if (toolIds.has(toolId)) {
			throw new Error(`Tool id collision after snake_case conversion: ${toolId}`);
		}
		toolIds.add(toolId);

		const parameters = [
			...pathParameters,
			...resolveParameters(operation.parameters),
		];
		const byLocation = new Map();
		for (const parameter of parameters) {
			const location = parameter.in;
			if (location === "cookie") {
				throw new Error(
					`Cookie parameters are not supported: ${operation.operationId}`,
				);
			}
			if (!["header", "path", "query"].includes(location)) continue;
			const values = byLocation.get(location) ?? [];
			values.push(parameter);
			byLocation.set(location, values);
		}

		const body = dereference(operation.requestBody);
		const bodySchema = requestBodySchema(operation.requestBody);
		const binaryPaths = collectBinaryPaths(bodySchema);
		for (const binary of binaryPaths) {
			if (binary.path.length !== 1 || binary.path[0] === "[]") {
				throw new Error(
					`Nested binary input is not supported yet: ${operation.operationId} body.${binary.path.join(".")}`,
				);
			}
		}

		operationRecords.push({
			operationId: operation.operationId,
			clientName: camelCase(operation.operationId),
			toolId,
			pascalName: pascalCase(camelCase(operation.operationId)),
			method: method.toUpperCase(),
			path,
			title: operation.summary ?? operation.operationId,
			description:
				operation.description ??
				operation.summary ??
				`${method.toUpperCase()} ${path}`,
			stability: operation["x-stability-level"] ?? "stable",
			deprecated: operation.deprecated === true,
			tags: operation.tags ?? [],
			hasBody: bodySchema !== undefined,
			bodyRequired: body?.required === true,
			binaryPaths,
			hasHeaders: byLocation.has("header"),
			headersRequired:
				byLocation.get("header")?.some((parameter) => parameter.required) ?? false,
			hasPath: byLocation.has("path"),
			hasQuery: byLocation.has("query"),
			queryRequired:
				byLocation.get("query")?.some((parameter) => parameter.required) ?? false,
		});
	}
}

operationRecords.sort((left, right) =>
	left.operationId.localeCompare(right.operationId),
);

const schemaFor = (record) => {
	const fields = [];
	if (record.hasBody) {
		let schema = `zod.z${record.pascalName}Body`;
		if (record.binaryPaths.length > 0) {
			const binaryFields = record.binaryPaths
				.map(({ path: [name], required }) => {
					const optional = required ? "" : ".optional()";
					return `${JSON.stringify(name)}: z.base64().describe("Base64-encoded binary file contents.")${optional}`;
				})
				.join(", ");
			schema = `${schema}.safeExtend({ ${binaryFields} })`;
		}
		fields.push(
			`\tbody: ${schema}${record.bodyRequired ? "" : ".optional()"},`,
		);
	}
	if (record.hasHeaders) {
		fields.push(
			`\theaders: zod.z${record.pascalName}Headers${record.headersRequired ? "" : ".optional()"},`,
		);
	}
	if (record.hasPath) {
		fields.push(`\tpath: zod.z${record.pascalName}Path,`);
	}
	if (record.hasQuery) {
		fields.push(
			`\tquery: zod.z${record.pascalName}Query${record.queryRequired ? "" : ".optional()"},`,
		);
	}
	return `z.object({\n${fields.join("\n")}\n})`;
};

const invocationFor = (record) => {
	const options = ["\t\t\t...input,"];
	let prelude = "";
	if (record.binaryPaths.length > 0) {
		const bindings = record.binaryPaths
			.map(
				({ path: [name] }, index) =>
					`[${JSON.stringify(name)}]: binary${index}`,
			)
			.join(", ");
		prelude = `\n\t\tconst { ${bindings}, ...body } = input.body;\n\t\treturn `;
		const fields = record.binaryPaths
			.map(({ path: [name] }, index) => {
				const key = JSON.stringify(name);
				return `\t\t\t\t...(binary${index} === undefined ? {} : { ${key}: decodeBase64(binary${index}) }),`;
			})
			.join("\n");
		options.push(`\t\t\tbody: {\n\t\t\t\t...input.body,\n${fields}\n\t\t\t},`);
		options[1] = `\t\t\tbody: {\n\t\t\t\t...body,\n${fields}\n\t\t\t},`;
	}
	options.push("\t\t\tclient,", "\t\t\tsignal,", "\t\t\tthrowOnError: true,");
	const call = `raw.${record.clientName}({\n${options.join("\n")}\n\t\t})`;
	return prelude ? `{${prelude}${call};\n\t}` : call;
};

const operationsSource = operationRecords
	.map((record) => {
		const readOnly = record.method === "GET" || record.method === "HEAD";
		const requiresApproval =
			!readOnly || approvalRequiredReads.has(record.operationId);
		const annotations = [
			`readOnlyHint: ${readOnly}`,
			...(readOnly ? [] : ["destructiveHint: true"]),
			...(readOnly ? ["idempotentHint: true"] : []),
			"openWorldHint: true",
		].join(", ");
		return `\t${JSON.stringify(record.operationId)}: (client: Client) =>
\t\tbindOperation(
\t\t\tdefineOperation({
\t\t\t\toperationId: ${JSON.stringify(record.operationId)},
\t\t\t\tid: ${JSON.stringify(record.toolId)},
\t\t\t\ttitle: ${JSON.stringify(record.title)},
\t\t\t\tdescription: ${JSON.stringify(record.description)},
\t\t\t\tinputSchema: ${schemaFor(record)},
\t\t\t\tannotations: { ${annotations} },
\t\t\t\trequiresApproval: ${requiresApproval},
\t\t\t\tmetadata: {
\t\t\t\t\tmethod: ${JSON.stringify(record.method)},
\t\t\t\t\tpath: ${JSON.stringify(record.path)},
\t\t\t\t\tstability: ${JSON.stringify(record.stability)},
\t\t\t\t\tdeprecated: ${record.deprecated},
\t\t\t\t\ttags: ${JSON.stringify(record.tags)},
\t\t\t\t},
\t\t\t\tinvoke: (client, input, signal) =>
\t\t\t\t\t${invocationFor(record)},
\t\t\t}),
\t\t\tclient,
\t\t),`;
	})
	.join("\n");

const source = `// This file is auto-generated by scripts/generate-tools.mjs. Do not edit.

import type { Client } from "@neon/sdk/raw";
import * as raw from "@neon/sdk/raw";
import * as z from "zod";
import * as zod from "./generated/zod.gen.js";
import { decodeBase64 } from "./lib/binary.js";
import { bindOperation, defineOperation } from "./lib/operation.js";

export const operationIds = ${JSON.stringify(
	operationRecords.map((record) => record.operationId),
	null,
	"\t",
)} as const;

export type NeonOperationId = (typeof operationIds)[number];

export const operationFactories = {
${operationsSource}
} as const;
`;

const zodSource = readFileSync(zodPath, "utf8").replace(
	/\.(?:min|max)\(BigInt\((?:['"])?-?\d+(?:['"])?\), \{ error: ['"][^'"]+['"] \}\)/g,
	"",
).replace(
	/\.default\(BigInt\((['"]?)(-?\d+)\1\)\)/g,
	(_match, _quote, digits) => {
		const value = Number(digits);
		if (!Number.isSafeInteger(value)) {
			throw new Error(`Unsafe int64 default cannot be a JSON number: ${digits}`);
		}
		return `.default(${digits})`;
	},
);
writeFileSync(zodPath, zodSource);
writeFileSync(outPath, source);
console.log(
	`generate-tools: wrote ${operationRecords.length} operations to ${outPath}`,
);
