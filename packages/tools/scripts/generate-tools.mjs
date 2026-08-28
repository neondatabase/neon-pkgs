import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, "../../sdk/spec/neon-openapi.json");
const outPath = resolve(here, "../src/operations.gen.ts");
const schemasPath = resolve(here, "../src/schemas.ts");
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

// OpenAPI x-sensitive fields also cover ordinary PII and fields omitted by
// specific endpoints, so approval remains an explicit operation-level policy.
const approvalRequiredReads = new Set([
	"getConnectionURI",
	"getNeonAuthEmailProvider",
	"getNeonAuthEmailServer",
	"getNeonAuthPluginConfigs",
	"getProjectBranchRolePassword",
	"listBranchNeonAuthOauthProviders",
	"listNeonAuthOauthProviders",
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

const allOfPropertyNames = (schema, references = new Set()) => {
	if (!schema || typeof schema !== "object") return new Set();
	if (schema.$ref) {
		if (references.has(schema.$ref)) return new Set();
		const nextReferences = new Set(references);
		nextReferences.add(schema.$ref);
		return allOfPropertyNames(resolveReference(schema.$ref), nextReferences);
	}
	const names = new Set(Object.keys(schema.properties ?? {}));
	for (const child of schema.allOf ?? []) {
		for (const name of allOfPropertyNames(child, references)) {
			names.add(name);
		}
	}
	return names;
};

const assertDisjointAllOf = (value, location = "#") => {
	if (Array.isArray(value)) {
		value.forEach((child, index) =>
			assertDisjointAllOf(child, `${location}/${index}`),
		);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value.allOf)) {
		const names = new Set(Object.keys(value.properties ?? {}));
		for (const child of value.allOf) {
			for (const name of allOfPropertyNames(child)) {
				if (names.has(name)) {
					throw new Error(
						`Cannot merge overlapping OpenAPI allOf property "${name}" at ${location}.`,
					);
				}
				names.add(name);
			}
		}
	}
	for (const [key, child] of Object.entries(value)) {
		assertDisjointAllOf(child, `${location}/${key}`);
	}
};

assertDisjointAllOf(document);

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

const stripMarkdownLinks = (text) =>
	text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

const firstSentence = (text) => {
	const normalized = stripMarkdownLinks(text).replace(/\s+/g, " ").trim();
	if (normalized.length === 0) {
		return "";
	}
	const match = normalized.match(/^.+?[.!?](?=\s|$)/);
	let sentence = (match ? match[0] : normalized).trim();
	if (/^deprecated\.?$/i.test(sentence)) {
		const rest = normalized.slice(sentence.length).trim();
		const second = rest.match(/^.+?[.!?](?=\s|$)/);
		if (second) {
			sentence = `${sentence} ${second[0]}`;
		}
	}
	return sentence;
};

const toolDescription = (operation, method, path) =>
	firstSentence(operation.description ?? "") ||
	(typeof operation.summary === "string" ? operation.summary.trim() : "") ||
	`${method.toUpperCase()} ${path}`;

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

// query `name` duplicates body `name` on restore; the body field is the
// documented name of the restored branch.
const droppedQueryByOperation = {
	restoreSnapshot: new Set(["name"]),
};

const isObjectSchema = (schema) =>
	Boolean(
		schema &&
			typeof schema === "object" &&
			(schema.type === "object" || schema.properties || schema.allOf),
	);

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

		const pathNames = (byLocation.get("path") ?? []).map(
			(parameter) => parameter.name,
		);
		const droppedQuery = droppedQueryByOperation[operation.operationId];
		const queryNames = (byLocation.get("query") ?? [])
			.map((parameter) => parameter.name)
			.filter((name) => !droppedQuery?.has(name));
		const headerNames = (byLocation.get("header") ?? []).map(
			(parameter) => parameter.name,
		);
		const resolvedBody = bodySchema ? dereference(bodySchema) : undefined;
		const bodyPropertyNames = [...allOfPropertyNames(bodySchema)];
		for (const binary of binaryPaths) {
			if (!bodyPropertyNames.includes(binary.path[0])) {
				bodyPropertyNames.push(binary.path[0]);
			}
		}
		const bodyPassthrough =
			bodySchema !== undefined &&
			bodyPropertyNames.length === 0 &&
			Boolean(resolvedBody?.oneOf || resolvedBody?.anyOf);

		const findProperty = (schema, name, references = new Set()) => {
			if (!schema || typeof schema !== "object") return undefined;
			if (schema.$ref) {
				if (references.has(schema.$ref)) return undefined;
				const next = new Set(references);
				next.add(schema.$ref);
				return findProperty(resolveReference(schema.$ref), name, next);
			}
			if (schema.properties?.[name]) {
				return dereference(schema.properties[name]);
			}
			for (const child of schema.allOf ?? []) {
				const found = findProperty(child, name, references);
				if (found) return found;
			}
			return undefined;
		};

		const isRequiredProperty = (schema, name, references = new Set()) => {
			if (!schema || typeof schema !== "object") return false;
			if (schema.$ref) {
				if (references.has(schema.$ref)) return false;
				const next = new Set(references);
				next.add(schema.$ref);
				return isRequiredProperty(
					resolveReference(schema.$ref),
					name,
					next,
				);
			}
			if ((schema.required ?? []).includes(name)) return true;
			return (schema.allOf ?? []).some((child) =>
				isRequiredProperty(child, name, references),
			);
		};

		let liftBodyKey;
		let liftBodyOptional = false;
		let publishedBodyNames = bodyPropertyNames;
		if (bodyPropertyNames.length === 1) {
			const wrapperName = bodyPropertyNames[0];
			const wrapperSchema = findProperty(bodySchema, wrapperName);
			if (isObjectSchema(wrapperSchema)) {
				liftBodyKey = wrapperName;
				liftBodyOptional = !isRequiredProperty(bodySchema, wrapperName);
				publishedBodyNames = [...allOfPropertyNames(wrapperSchema)];
			}
		}

		const publishedNames = [
			...pathNames,
			...queryNames,
			...headerNames,
			...(bodyPassthrough ? ["body"] : publishedBodyNames),
		];
		const seenPublished = new Set();
		for (const name of publishedNames) {
			if (seenPublished.has(name)) {
				throw new Error(
					`Cannot flatten overlapping parameter "${name}" on ${operation.operationId}.`,
				);
			}
			seenPublished.add(name);
		}

		const queryRequired = (byLocation.get("query") ?? []).some(
			(parameter) =>
				parameter.required && !droppedQuery?.has(parameter.name),
		);

		operationRecords.push({
			operationId: operation.operationId,
			clientName: camelCase(operation.operationId),
			toolId,
			pascalName: pascalCase(camelCase(operation.operationId)),
			method: method.toUpperCase(),
			path,
			title: operation.summary ?? operation.operationId,
			description: toolDescription(operation, method, path),
			stability: operation["x-stability-level"] ?? "stable",
			deprecated: operation.deprecated === true,
			tags: operation.tags ?? [],
			hasBody: bodySchema !== undefined,
			bodyRequired: body?.required === true,
			bodyNames: publishedBodyNames,
			bodyPassthrough,
			liftBodyKey,
			liftBodyOptional,
			binaryPaths,
			hasHeaders: byLocation.has("header"),
			headerNames,
			headersRequired:
				byLocation.get("header")?.some((parameter) => parameter.required) ??
				false,
			hasPath: byLocation.has("path"),
			pathNames,
			hasQuerySchema: byLocation.has("query"),
			hasQuery: queryNames.length > 0,
			queryNames,
			queryRequired,
		});
	}
}

operationRecords.sort((left, right) =>
	left.operationId.localeCompare(right.operationId),
);

const shapeRef = (schemaExpr, name) =>
	`${schemaExpr}.shape[${JSON.stringify(name)}]`;

const schemaField = (name, expr, optionalize) =>
	`\t${JSON.stringify(name)}: ${optionalize ? `${expr}.optional()` : expr},`;

const schemaFor = (record) => {
	const fields = [];
	const binaryByName = new Map(
		record.binaryPaths.map((binary) => [binary.path[0], binary]),
	);

	const addFields = (schemaExpr, names, optionalizeGroup) => {
		for (const name of names) {
			const binary = binaryByName.get(name);
			if (binary) {
				const optional = optionalizeGroup || !binary.required;
				fields.push(
					`\t${JSON.stringify(name)}: z.base64().describe("Base64-encoded binary file contents.")${optional ? ".optional()" : ""},`,
				);
				continue;
			}
			fields.push(
				schemaField(
					name,
					shapeRef(schemaExpr, name),
					optionalizeGroup,
				),
			);
		}
	};

	if (record.hasPath) {
		addFields(`zod.z${record.pascalName}Path`, record.pathNames, false);
	}
	if (record.hasQuery) {
		addFields(
			`zod.z${record.pascalName}Query`,
			record.queryNames,
			!record.queryRequired,
		);
	}
	if (record.hasHeaders) {
		addFields(
			`zod.z${record.pascalName}Headers`,
			record.headerNames,
			!record.headersRequired,
		);
	}
	if (record.bodyPassthrough) {
		fields.push(
			schemaField(
				"body",
				`zod.z${record.pascalName}Body`,
				!record.bodyRequired,
			),
		);
	} else if (record.hasBody && record.bodyNames.length > 0) {
		const bodyExpr = record.liftBodyKey
			? `${shapeRef(`zod.z${record.pascalName}Body`, record.liftBodyKey)}${
					record.liftBodyOptional ? ".unwrap()" : ""
				}`
			: `zod.z${record.pascalName}Body`;
		addFields(bodyExpr, record.bodyNames, !record.bodyRequired);
	}
	return `z.strictObject({\n${fields.join("\n")}\n})`;
};

const invocationFor = (record) => {
	const pickFields = (names) =>
		names
			.map(
				(name) =>
					`${JSON.stringify(name)}: input[${JSON.stringify(name)}]`,
			)
			.join(", ");
	const groupExpr = (names, required) =>
		`optionalGroup({ ${pickFields(names)} }, ${required})`;
	const options = [];
	if (record.hasPath) {
		options.push(
			`path: ${groupExpr(record.pathNames, true)}`,
		);
	}
	if (record.hasQuery) {
		options.push(
			`query: ${groupExpr(record.queryNames, record.queryRequired)}`,
		);
	}
	if (record.hasHeaders) {
		options.push(
			`headers: ${groupExpr(record.headerNames, record.headersRequired)}`,
		);
	}
	if (record.bodyPassthrough) {
		options.push("body: input.body");
	} else if (record.hasBody) {
		const inner = groupExpr(record.bodyNames, record.bodyRequired);
		if (record.liftBodyKey) {
			options.push(
				`body: optionalGroup({ ${JSON.stringify(record.liftBodyKey)}: ${groupExpr(record.bodyNames, !record.liftBodyOptional)} }, ${record.bodyRequired})`,
			);
		} else if (record.binaryPaths.length > 0) {
			const binaryNames = record.binaryPaths.map((binary) => binary.path[0]);
			options.push(
				`body: decodeBinaryFields(${inner}, ${JSON.stringify(binaryNames)}, decodeBase64)`,
			);
		} else {
			options.push(`body: ${inner}`);
		}
	}
	const fields = [
		...options,
		"client",
		"signal",
		"throwOnError: true",
	];
	return `raw.${record.clientName}({\n\t\t\t${fields.join(",\n\t\t\t")},\n\t\t})`;
};

const operationsSource = operationRecords
	.map((record) => {
		const readOnly = record.method === "GET" || record.method === "HEAD";
		const requiresApproval =
			!readOnly || approvalRequiredReads.has(record.operationId);
		const annotations = [
			`readOnlyHint: ${readOnly}`,
			...(readOnly ? [] : ["destructiveHint: true"]),
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

const requestSchemaNames = operationRecords
	.flatMap((record) => [
		...(record.hasBody ? [`z${record.pascalName}Body`] : []),
		...(record.hasHeaders ? [`z${record.pascalName}Headers`] : []),
		...(record.hasPath ? [`z${record.pascalName}Path`] : []),
		...(record.hasQuerySchema ? [`z${record.pascalName}Query`] : []),
	])
	.sort((left, right) => left.localeCompare(right));

const source = `// This file is auto-generated by scripts/generate-tools.mjs. Do not edit.

import type { Client } from "@neon/sdk/raw";
import * as raw from "@neon/sdk/raw";
import * as z from "zod";
import * as zod from "./generated/zod.gen.js";
import { decodeBase64 } from "./lib/binary.js";
import { decodeBinaryFields, optionalGroup } from "./lib/envelope.js";
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

const schemasSource = `// This file is auto-generated by scripts/generate-tools.mjs. Do not edit.
// biome-ignore-all assist/source/organizeImports: Generated exports follow generator order.

export {
${requestSchemaNames.map((name) => `\t${name},`).join("\n")}
} from "./generated/zod.gen.js";
`;

const generatedZodSource = readFileSync(zodPath, "utf8");
if (generatedZodSource.includes("z.intersection(")) {
	throw new Error(
		"Generated request schemas contain intersections; merge their object shapes before enabling strict validation.",
	);
}
const zodSource = generatedZodSource
	.replaceAll(".and(", ".merge(")
	.replace(
		/\.(min|max|gte|lte|gt|lt)\(BigInt\((['"]?)(-?\d+)\2\)(, \{ error: ['"][^'"]+['"] \})?\)/g,
		(_match, method, _quote, digits, options = "") => {
			const value = Number(digits);
			return Number.isSafeInteger(value)
				? `.${method}(${digits}${options})`
				: "";
		},
	)
	.replace(
		/\.default\(BigInt\((['"]?)(-?\d+)\1\)\)/g,
		(_match, _quote, digits) => {
			const value = Number(digits);
			if (!Number.isSafeInteger(value)) {
				throw new Error(
					`Unsafe int64 default cannot be a JSON number: ${digits}`,
				);
			}
			return `.default(${digits})`;
		},
	)
	.replace(
		/\.default\((?:true|false|-?\d+(?:\.\d+)?|'(?:\\.|[^'])*'|"(?:\\.|[^"])*")\)/g,
		"",
	)
	.replaceAll("z.object(", "z.strictObject(");
if (zodSource.includes(".default(")) {
	throw new Error("Generated request schemas contain an unsupported default value.");
}
writeFileSync(zodPath, zodSource);
writeFileSync(outPath, source);
writeFileSync(schemasPath, schemasSource);
console.log(
	`generate-tools: wrote ${operationRecords.length} operations to ${outPath}`,
);
