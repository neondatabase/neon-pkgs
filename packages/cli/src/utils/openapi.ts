// Spec loader for `neon api --list` and `neon api <path> --describe`.
// `neon api <path>` request mode does not use this module — it is a pure
// passthrough — so a stale or unreachable spec never blocks a real API call.
// Listing and describe degrade gracefully: fresh cache → live fetch → stale
// cache → clear error.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { log } from "../log.js";

/** Public URL of the released Neon OpenAPI v2 spec. */
export const DEFAULT_SPEC_URL = "https://neon.com/api_spec/release/v2.json";

const CACHE_FILE = "openapi-spec.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const HTTP_METHODS = new Set([
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"head",
	"options",
]);

const DESCRIBE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

type Operation = {
	operationId?: string;
	summary?: string;
	description?: string;
	tags?: string[];
};

type PathItem = Record<string, unknown>;

export type OpenApiSpec = {
	paths?: Record<string, PathItem>;
	components?: {
		schemas?: Record<string, unknown>;
		parameters?: Record<string, unknown>;
	};
	servers?: { url: string }[];
	info?: { version?: string };
};

/** A single (method, path) route flattened from the spec. */
export type EndpointInfo = {
	method: string;
	path: string;
	summary?: string;
	operationId?: string;
	tags: string[];
};

export type ParameterLocation = "path" | "query" | "header" | "body";

export type ItemProperty = {
	name: string;
	type: string;
	required: boolean;
	description: string;
	enum?: unknown[];
	nullable?: boolean;
};

export type DescribedField = {
	in: ParameterLocation;
	name: string;
	required: boolean;
	type: string;
	description: string;
	enum?: unknown[];
	nullable?: boolean;
	items?: {
		type: string;
		properties?: ItemProperty[];
	};
};

export type OperationDescription = {
	method: string;
	path: string;
	summary: string;
	operationId: string;
	bodyRequired: boolean;
	fields: DescribedField[];
};

type CachedSpec = {
	fetchedAt: number;
	specUrl: string;
	spec: OpenApiSpec;
};

async function fetchSpec(url: string): Promise<OpenApiSpec> {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});
		if (!res.ok) {
			throw new Error(
				`Failed to fetch OpenAPI spec (${res.status} ${res.statusText})`,
			);
		}
		return (await res.json()) as OpenApiSpec;
	} finally {
		clearTimeout(timer);
	}
}

function readCache(cachePath: string): CachedSpec | null {
	try {
		return JSON.parse(readFileSync(cachePath, "utf8")) as CachedSpec;
	} catch {
		return null;
	}
}

function writeCache(cachePath: string, data: CachedSpec): void {
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, JSON.stringify(data));
	} catch (err) {
		log.debug("Failed to cache OpenAPI spec: %s", err);
	}
}

/**
 * Load the Neon OpenAPI spec, preferring a fresh on-disk cache, then a live
 * fetch (which refreshes the cache), then a stale cache as a last resort.
 * Returns `null` when no spec can be obtained.
 */
export async function loadSpec(opts: {
	configDir: string;
	specUrl: string;
	refresh: boolean;
}): Promise<OpenApiSpec | null> {
	const { configDir, specUrl, refresh } = opts;
	const cachePath = join(configDir, CACHE_FILE);

	if (!refresh) {
		const cached = readCache(cachePath);
		if (
			cached &&
			cached.specUrl === specUrl &&
			Date.now() - cached.fetchedAt < CACHE_TTL_MS
		) {
			log.debug("Using cached OpenAPI spec from %s", cachePath);
			return cached.spec;
		}
	}

	try {
		log.debug("Fetching OpenAPI spec from %s", specUrl);
		const spec = await fetchSpec(specUrl);
		writeCache(cachePath, { fetchedAt: Date.now(), specUrl, spec });
		return spec;
	} catch (err) {
		log.debug("Failed to fetch OpenAPI spec: %s", err);
		const stale = readCache(cachePath);
		if (stale && stale.specUrl === specUrl) {
			log.debug("Falling back to stale cached OpenAPI spec");
			return stale.spec;
		}
		return null;
	}
}

/** Flatten a spec into a sorted list of routes (by path, then method). */
export function getEndpoints(spec: OpenApiSpec): EndpointInfo[] {
	const endpoints: EndpointInfo[] = [];
	for (const [path, item] of Object.entries(spec.paths ?? {})) {
		for (const [method, op] of Object.entries(item)) {
			if (!HTTP_METHODS.has(method.toLowerCase())) {
				continue;
			}
			const operation = (op ?? {}) as Operation;
			endpoints.push({
				method: method.toUpperCase(),
				path,
				summary: operation.summary,
				operationId: operation.operationId,
				tags: operation.tags ?? [],
			});
		}
	}
	endpoints.sort((a, b) =>
		a.path === b.path
			? a.method.localeCompare(b.method)
			: a.path.localeCompare(b.path),
	);
	return endpoints;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

function stringDesc(value: unknown): string {
	if (!isRecord(value) || typeof value.description !== "string") {
		return "";
	}
	return value.description.trim();
}

function specRecord(spec: OpenApiSpec): Record<string, unknown> {
	return spec;
}

function resolveRef(spec: OpenApiSpec, ref: string): unknown {
	if (!ref.startsWith("#/")) {
		throw new Error(
			`Unsupported $ref "${ref}". Only document-local refs are resolved.`,
		);
	}
	let node: unknown = specRecord(spec);
	for (const part of ref.slice(2).split("/")) {
		const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
		if (!isRecord(node) || !(key in node)) {
			throw new Error(`Unresolved $ref ${ref}.`);
		}
		node = node[key];
	}
	return node;
}

function schemaType(schema: Record<string, unknown>): string {
	const t = schema.type;
	if (typeof t === "string") {
		return t;
	}
	if (Array.isArray(t)) {
		const first = t.find(
			(item): item is string => typeof item === "string",
		);
		if (first) {
			return first;
		}
	}
	if (schema.items !== undefined) {
		return "array";
	}
	if (
		isRecord(schema.properties) ||
		schema.additionalProperties !== undefined
	) {
		return "object";
	}
	if (Array.isArray(schema.enum)) {
		return "string";
	}
	return "object";
}

function optionalEnum(
	schema: Record<string, unknown>,
): { enum: unknown[] } | Record<string, never> {
	return Array.isArray(schema.enum) ? { enum: schema.enum } : {};
}

function optionalNullable(
	schema: Record<string, unknown>,
): { nullable: true } | Record<string, never> {
	return schema.nullable === true ? { nullable: true } : {};
}

function mergeSchema(
	base: Record<string, unknown>,
	overlay: Record<string, unknown>,
): Record<string, unknown> {
	const properties = {
		...(isRecord(base.properties) ? base.properties : {}),
		...(isRecord(overlay.properties) ? overlay.properties : {}),
	};
	const required = [
		...new Set([
			...asStringArray(base.required),
			...asStringArray(overlay.required),
		]),
	];
	const overlayDesc = stringDesc(overlay);
	const description = overlayDesc || stringDesc(base);
	return {
		...base,
		...overlay,
		properties,
		required,
		...(description ? { description } : {}),
	};
}

function resolveSchema(
	spec: OpenApiSpec,
	schema: unknown,
	stack: string[],
): Record<string, unknown> {
	if (!isRecord(schema)) {
		return {};
	}
	if (typeof schema.$ref === "string") {
		const ref = schema.$ref;
		const { $ref: _ref, ...siblings } = schema;
		if (stack.includes(ref)) {
			return { type: "object", ...siblings };
		}
		const resolved = resolveSchema(spec, resolveRef(spec, ref), [
			...stack,
			ref,
		]);
		return mergeSchema(resolved, siblings);
	}
	if (Array.isArray(schema.allOf)) {
		const { allOf, ...rest } = schema;
		let merged: Record<string, unknown> = {
			type: "object",
			properties: {},
			required: [],
		};
		for (const part of allOf) {
			merged = mergeSchema(merged, resolveSchema(spec, part, stack));
		}
		return mergeSchema(merged, rest);
	}
	return schema;
}

function fieldFromSchema(
	location: ParameterLocation,
	name: string,
	required: boolean,
	schema: Record<string, unknown>,
): DescribedField {
	return {
		in: location,
		name,
		required,
		type: schemaType(schema),
		description: stringDesc(schema),
		...optionalEnum(schema),
		...optionalNullable(schema),
	};
}

function arrayField(
	spec: OpenApiSpec,
	name: string,
	required: boolean,
	schema: Record<string, unknown>,
): DescribedField {
	const items = isRecord(schema.items)
		? resolveSchema(spec, schema.items, [])
		: {};
	const itemType = schemaType(items);
	const properties = isRecord(items.properties)
		? items.properties
		: undefined;
	const requiredItems = new Set(asStringArray(items.required));
	const field: DescribedField = {
		in: "body",
		name,
		required,
		type: "array",
		description: stringDesc(schema),
		items: {
			type: itemType,
			...(properties
				? {
						properties: Object.entries(properties).map(
							([propName, propSchema]) => {
								const resolved = resolveSchema(
									spec,
									propSchema,
									[],
								);
								return {
									name: propName,
									type: schemaType(resolved),
									required: requiredItems.has(propName),
									description: stringDesc(resolved),
									...optionalEnum(resolved),
									...optionalNullable(resolved),
								};
							},
						),
					}
				: {}),
		},
	};
	return field;
}

function flattenBody(
	spec: OpenApiSpec,
	schema: unknown,
	prefix: string,
): DescribedField[] {
	const resolved = resolveSchema(spec, schema, []);
	const properties = isRecord(resolved.properties)
		? resolved.properties
		: undefined;
	if (!properties) {
		if (prefix === "") {
			return [];
		}
		if (schemaType(resolved) === "array") {
			return [arrayField(spec, prefix, false, resolved)];
		}
		return [fieldFromSchema("body", prefix, false, resolved)];
	}
	const requiredSet = new Set(asStringArray(resolved.required));
	const fields: DescribedField[] = [];
	for (const [key, prop] of Object.entries(properties)) {
		const name = prefix ? `${prefix}.${key}` : key;
		const required = requiredSet.has(key);
		const resolvedProp = resolveSchema(spec, prop, []);
		const type = schemaType(resolvedProp);
		if (type === "object" && isRecord(resolvedProp.properties)) {
			fields.push(...flattenBody(spec, resolvedProp, name));
			continue;
		}
		if (type === "array") {
			fields.push(arrayField(spec, name, required, resolvedProp));
			continue;
		}
		fields.push(fieldFromSchema("body", name, required, resolvedProp));
	}
	return fields;
}

function resolveParameter(
	spec: OpenApiSpec,
	parameter: unknown,
): Record<string, unknown> | null {
	if (!isRecord(parameter)) {
		return null;
	}
	if (typeof parameter.$ref === "string") {
		const resolved = resolveRef(spec, parameter.$ref);
		if (!isRecord(resolved)) {
			throw new Error(`Unresolved $ref ${parameter.$ref}.`);
		}
		const { $ref: _ref, ...siblings } = parameter;
		return mergeSchema(resolved, siblings);
	}
	return parameter;
}

function paramToField(
	spec: OpenApiSpec,
	param: Record<string, unknown>,
): DescribedField | null {
	const location = param.in;
	if (location !== "path" && location !== "query" && location !== "header") {
		return null;
	}
	if (typeof param.name !== "string") {
		return null;
	}
	const schema = isRecord(param.schema)
		? resolveSchema(spec, param.schema, [])
		: {};
	const required =
		location === "path"
			? param.required !== false
			: param.required === true;
	return {
		in: location,
		name: param.name,
		required,
		type: schemaType(schema),
		description: stringDesc(param) || stringDesc(schema),
		...optionalEnum(schema),
		...optionalNullable(schema),
	};
}

function pathParamNames(template: string): string[] {
	return [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function pathMatchesTemplate(path: string, template: string): boolean {
	const pathParts = path.split("/");
	const templateParts = template.split("/");
	if (pathParts.length !== templateParts.length) {
		return false;
	}
	return templateParts.every((part, i) => {
		if (part.startsWith("{") && part.endsWith("}")) {
			return pathParts[i] !== "";
		}
		return part === pathParts[i];
	});
}

function matchPath(
	spec: OpenApiSpec,
	requestPath: string,
): { template: string; pathItem: Record<string, unknown> } {
	const path = requestPath.split("?")[0] ?? requestPath;
	const paths = spec.paths ?? {};
	const exact = paths[path];
	if (isRecord(exact)) {
		return { template: path, pathItem: exact };
	}
	const matches = Object.entries(paths).filter(
		([template, item]) =>
			isRecord(item) && pathMatchesTemplate(path, template),
	);
	if (matches.length === 0) {
		throw new Error(
			`No route matches "${path}". Run \`neon api --list\` to see available routes.`,
		);
	}
	matches.sort((a, b) => {
		const staticA = a[0]
			.split("/")
			.filter((p) => !p.startsWith("{")).length;
		const staticB = b[0]
			.split("/")
			.filter((p) => !p.startsWith("{")).length;
		return staticB - staticA;
	});
	const [template, pathItem] = matches[0];
	if (!isRecord(pathItem)) {
		throw new Error(
			`No route matches "${path}". Run \`neon api --list\` to see available routes.`,
		);
	}
	return { template, pathItem };
}

function availableMethods(pathItem: Record<string, unknown>): string[] {
	return DESCRIBE_METHODS.filter((method) =>
		isRecord(pathItem[method.toLowerCase()]),
	);
}

function collectParameters(
	spec: OpenApiSpec,
	pathItem: Record<string, unknown>,
	operation: Record<string, unknown>,
	template: string,
): DescribedField[] {
	const raw = [
		...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
		...(Array.isArray(operation.parameters) ? operation.parameters : []),
	];
	const byKey = new Map<string, DescribedField>();
	for (const entry of raw) {
		const resolved = resolveParameter(spec, entry);
		if (!resolved) {
			continue;
		}
		const field = paramToField(spec, resolved);
		if (!field) {
			continue;
		}
		byKey.set(`${field.in}:${field.name}`, field);
	}
	const pathFields = pathParamNames(template).map((name) => {
		const existing = byKey.get(`path:${name}`);
		if (existing) {
			return existing;
		}
		return {
			in: "path" as const,
			name,
			required: true,
			type: "string",
			description: "",
		};
	});
	const query = [...byKey.values()].filter((field) => field.in === "query");
	const header = [...byKey.values()].filter((field) => field.in === "header");
	return [...pathFields, ...query, ...header];
}

function jsonBodySchema(
	spec: OpenApiSpec,
	operation: Record<string, unknown>,
): { schema: unknown; required: boolean } | null {
	let requestBody = operation.requestBody;
	if (isRecord(requestBody) && typeof requestBody.$ref === "string") {
		requestBody = resolveRef(spec, requestBody.$ref);
	}
	if (!isRecord(requestBody)) {
		return null;
	}
	const content = requestBody.content;
	if (!isRecord(content)) {
		return null;
	}
	const json = content["application/json"];
	if (!isRecord(json) || json.schema === undefined) {
		return null;
	}
	return { schema: json.schema, required: requestBody.required === true };
}

export function describeOperation(
	spec: OpenApiSpec,
	path: string,
	method: string,
): OperationDescription {
	const methodUpper = method.toUpperCase();
	const { template, pathItem } = matchPath(spec, path);
	const available = availableMethods(pathItem);
	const operation = pathItem[methodUpper.toLowerCase()];
	if (!isRecord(operation)) {
		const hint =
			available.length > 0
				? ` Available: ${available.join(", ")}. Pass -X ${available[0]}.`
				: " Run `neon api --list` to see available routes.";
		throw new Error(`No ${methodUpper} ${template} in the spec.${hint}`);
	}
	const body = jsonBodySchema(spec, operation);
	const fields = [
		...collectParameters(spec, pathItem, operation, template),
		...(body ? flattenBody(spec, body.schema, "") : []),
	];
	return {
		method: methodUpper,
		path: template,
		summary: typeof operation.summary === "string" ? operation.summary : "",
		operationId:
			typeof operation.operationId === "string"
				? operation.operationId
				: "",
		bodyRequired: body?.required === true,
		fields,
	};
}
