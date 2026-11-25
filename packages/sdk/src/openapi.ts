/**
 * The Neon OpenAPI spec as data: list, search, and describe its endpoints. Pure, apart
 * from {@link fetchOpenApiSpec}. `neon api --list`, `neon api --describe`, and the
 * `api.search` agent tool are built on it.
 */

/** Public URL of the released Neon OpenAPI v2 spec. */
export const NEON_OPENAPI_SPEC_URL =
	"https://neon.com/api_spec/release/v2.json";

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
		enum?: unknown[];
		nullable?: boolean;
		properties?: ItemProperty[];
	};
};

export type EndpointDescription = {
	method: string;
	path: string;
	summary: string;
	operationId: string;
	bodyRequired: boolean;
	contentType: string;
	fields: DescribedField[];
};

export interface FetchOpenApiSpecOptions {
	/** Defaults to {@link NEON_OPENAPI_SPEC_URL}. */
	url?: string;
	fetch?: typeof fetch;
	/** Cancels the fetch. It also stops after 10 seconds regardless. */
	signal?: AbortSignal;
}

/** Fetch the spec. Throws on a network failure, a timeout, a non-2xx status, or a body that is not JSON. */
export async function fetchOpenApiSpec(
	options: FetchOpenApiSpecOptions = {},
): Promise<OpenApiSpec> {
	const url = options.url ?? NEON_OPENAPI_SPEC_URL;
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const signal =
		options.signal === undefined
			? timeout
			: AbortSignal.any([options.signal, timeout]);
	const res = await (options.fetch ?? fetch)(url, {
		signal,
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		throw new Error(
			`Failed to fetch the Neon OpenAPI spec from ${url} (${res.status} ${res.statusText})`,
		);
	}
	const spec: unknown = await res.json();
	if (!isOpenApiSpec(spec)) {
		throw new Error(
			`${url} did not return an OpenAPI spec: the body has no "paths" object`,
		);
	}
	return spec;
}

/** Flatten a spec into a sorted list of routes (by path, then method). */
export function listEndpoints(spec: OpenApiSpec): EndpointInfo[] {
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

const searchTokens = (text: string): string[] =>
	text
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 2)
		.map((token) =>
			token.length > 3 && token.endsWith("s") && !token.endsWith("ss")
				? token.slice(0, -1)
				: token,
		);

export interface SearchEndpointsOptions {
	/** Defaults to 10. */
	limit?: number;
}

/**
 * Endpoints ranked by how many words of `query` their method, path, summary,
 * operationId, and tags contain, then by how many of those are in the summary, then
 * by the fewest other summary words. Endpoints that contain none are left out.
 */
export function searchEndpoints(
	spec: OpenApiSpec,
	query: string,
	options: SearchEndpointsOptions = {},
): EndpointInfo[] {
	const wanted = [...new Set(searchTokens(query))];
	if (wanted.length === 0) {
		return [];
	}
	const ranked = listEndpoints(spec).flatMap((endpoint) => {
		const summary = new Set(searchTokens(endpoint.summary ?? ""));
		const words = new Set([
			...summary,
			...searchTokens(endpoint.operationId ?? ""),
			...searchTokens(endpoint.path.replace(/\{[^}]*\}/g, "")),
			...endpoint.tags.flatMap(searchTokens),
			endpoint.method.toLowerCase(),
		]);
		const matched = wanted.filter((token) => words.has(token)).length;
		if (matched === 0) {
			return [];
		}
		const inSummary = wanted.filter((token) => summary.has(token)).length;
		return [
			{ endpoint, matched, inSummary, extra: summary.size - inSummary },
		];
	});
	ranked.sort(
		(a, b) =>
			b.matched - a.matched ||
			b.inSummary - a.inSummary ||
			a.extra - b.extra,
	);
	return ranked.slice(0, options.limit ?? 10).map(({ endpoint }) => endpoint);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenApiSpec(value: unknown): value is OpenApiSpec {
	return (
		isRecord(value) &&
		isRecord(value.paths) &&
		Object.values(value.paths).every(isRecord)
	);
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

function pushedRefs(schema: unknown, stack: string[]): string[] {
	if (!isRecord(schema)) {
		return stack;
	}
	let next = stack;
	if (typeof schema.$ref === "string" && !next.includes(schema.$ref)) {
		next = [...next, schema.$ref];
	}
	if (Array.isArray(schema.allOf)) {
		for (const part of schema.allOf) {
			next = pushedRefs(part, next);
		}
	}
	return next;
}

function arrayField(
	spec: OpenApiSpec,
	name: string,
	required: boolean,
	schema: Record<string, unknown>,
	stack: string[],
): DescribedField {
	const items = isRecord(schema.items)
		? resolveSchema(spec, schema.items, stack)
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
			...optionalEnum(items),
			...optionalNullable(items),
			...(properties
				? {
						properties: Object.entries(properties).map(
							([propName, propSchema]) => {
								const resolved = resolveSchema(
									spec,
									propSchema,
									stack,
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

function unionMembers(schema: Record<string, unknown>): unknown[] {
	if (Array.isArray(schema.oneOf)) {
		return schema.oneOf;
	}
	if (Array.isArray(schema.anyOf)) {
		return schema.anyOf;
	}
	return [];
}

function discriminatorField(
	schema: Record<string, unknown>,
	prefix: string,
): DescribedField | null {
	if (!isRecord(schema.discriminator)) {
		return null;
	}
	const propertyName = schema.discriminator.propertyName;
	if (typeof propertyName !== "string") {
		return null;
	}
	const mapping = schema.discriminator.mapping;
	const values = isRecord(mapping) ? Object.keys(mapping) : [];
	return {
		in: "body",
		name: prefix ? `${prefix}.${propertyName}` : propertyName,
		required: true,
		type: "string",
		description: "",
		...(values.length > 0 ? { enum: values } : {}),
	};
}

function flattenUnion(
	spec: OpenApiSpec,
	schema: Record<string, unknown>,
	prefix: string,
	stack: string[],
): DescribedField[] {
	const members = unionMembers(schema);
	const byName = new Map<string, DescribedField[]>();
	for (const member of members) {
		const seen = new Set<string>();
		for (const field of flattenBody(spec, member, prefix, stack)) {
			if (seen.has(field.name)) {
				continue;
			}
			seen.add(field.name);
			const copies = byName.get(field.name) ?? [];
			copies.push(field);
			byName.set(field.name, copies);
		}
	}
	const fields: DescribedField[] = [];
	for (const copies of byName.values()) {
		fields.push({
			...copies[0],
			required:
				copies.length === members.length &&
				copies.every((field) => field.required),
		});
	}
	const discriminator = discriminatorField(schema, prefix);
	if (discriminator && !byName.has(discriminator.name)) {
		fields.unshift(discriminator);
	} else if (discriminator) {
		const existing = fields.find(
			(field) => field.name === discriminator.name,
		);
		if (existing) {
			existing.required = true;
			if (!existing.enum && discriminator.enum) {
				existing.enum = discriminator.enum;
			}
		}
	}
	return fields;
}

function flattenBody(
	spec: OpenApiSpec,
	schema: unknown,
	prefix: string,
	stack: string[] = [],
): DescribedField[] {
	const nextStack = pushedRefs(schema, stack);
	const resolved = resolveSchema(spec, schema, stack);
	if (unionMembers(resolved).length > 0) {
		return flattenUnion(spec, resolved, prefix, nextStack);
	}
	const properties = isRecord(resolved.properties)
		? resolved.properties
		: undefined;
	if (!properties) {
		if (prefix === "") {
			return [];
		}
		if (schemaType(resolved) === "array") {
			return [arrayField(spec, prefix, false, resolved, nextStack)];
		}
		return [fieldFromSchema("body", prefix, false, resolved)];
	}
	const requiredSet = new Set(asStringArray(resolved.required));
	const fields: DescribedField[] = [];
	for (const [key, prop] of Object.entries(properties)) {
		const name = prefix ? `${prefix}.${key}` : key;
		const required = requiredSet.has(key);
		const resolvedProp = resolveSchema(spec, prop, nextStack);
		const type = schemaType(resolvedProp);
		if (type === "object" && isRecord(resolvedProp.properties)) {
			fields.push(...flattenBody(spec, prop, name, nextStack));
			continue;
		}
		if (type === "array") {
			fields.push(
				arrayField(spec, name, required, resolvedProp, nextStack),
			);
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
		const description = stringDesc(siblings) || stringDesc(resolved);
		return {
			...resolved,
			...siblings,
			...(description ? { description } : {}),
		};
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
	const type = schemaType(schema);
	const itemSchema =
		type === "array" && isRecord(schema.items)
			? resolveSchema(spec, schema.items, [])
			: null;
	return {
		in: location,
		name: param.name,
		required,
		type,
		description: stringDesc(param) || stringDesc(schema),
		...optionalEnum(schema),
		...optionalNullable(schema),
		...(itemSchema
			? {
					items: {
						type: schemaType(itemSchema),
						...optionalEnum(itemSchema),
						...optionalNullable(itemSchema),
					},
				}
			: {}),
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

/**
 * No endpoint in the spec matches `path`, or none for `method`. `available` lists the
 * methods the matched route does have.
 */
export class EndpointNotFoundError extends Error {
	readonly path: string;
	readonly method: string | undefined;
	readonly available: readonly string[];

	constructor(
		path: string,
		method: string | undefined,
		available: readonly string[],
	) {
		super(
			method === undefined
				? `No route matches "${path}".`
				: available.length > 0
					? `No ${method} ${path} in the spec. Available: ${available.join(", ")}.`
					: `No ${method} ${path} in the spec.`,
		);
		this.name = "EndpointNotFoundError";
		this.path = path;
		this.method = method;
		this.available = available;
	}
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
		throw new EndpointNotFoundError(path, undefined, []);
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
		throw new EndpointNotFoundError(path, undefined, []);
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
): { schema: unknown; required: boolean; contentType: string } | null {
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
	let contentType = "application/json";
	let selected: unknown = json;
	if (!isRecord(json)) {
		const entry = Object.entries(content).find(([, value]) =>
			isRecord(value),
		);
		if (!entry) {
			return null;
		}
		contentType = entry[0];
		selected = entry[1];
	}
	if (!isRecord(selected) || selected.schema === undefined) {
		return null;
	}
	return {
		schema: selected.schema,
		required: requestBody.required === true,
		contentType,
	};
}

/** The path, query, header, and body fields of one endpoint. `path` may be concrete (`/projects/abc`) or the template. */
export function describeEndpoint(
	spec: OpenApiSpec,
	path: string,
	method: string,
): EndpointDescription {
	const methodUpper = method.toUpperCase();
	const { template, pathItem } = matchPath(spec, path);
	const available = availableMethods(pathItem);
	const operation = pathItem[methodUpper.toLowerCase()];
	if (!isRecord(operation)) {
		throw new EndpointNotFoundError(template, methodUpper, available);
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
		contentType: body?.contentType ?? "",
		fields,
	};
}
