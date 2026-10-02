import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import chalk from "chalk";
import YAML from "yaml";
import type yargs from "yargs";

import { codeFromBody, isNeonApiError, type RequestParams } from "../api.js";
import type { CommonProps } from "../types.js";
import {
	DEFAULT_SPEC_URL,
	describeOperation,
	getEndpoints,
	loadSpec,
} from "../utils/openapi.js";
import { writer } from "../writer.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/**
 * Coerce a raw string into a typed JSON value: booleans, `null`, integers,
 * floats, and JSON arrays/objects are parsed; everything else stays a string.
 */
export function parseTypedValue(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null") return null;
	if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw);
	if (raw.startsWith("[") || raw.startsWith("{")) {
		try {
			return JSON.parse(raw);
		} catch {
			return raw;
		}
	}
	return raw;
}

/** Split a `key=value` pair on the first `=`. */
export function parseKeyValue(input: string): { key: string; value: string } {
	const eq = input.indexOf("=");
	if (eq === -1) {
		throw new Error(`Invalid "key=value" pair: "${input}".`);
	}
	return { key: input.slice(0, eq), value: input.slice(eq + 1) };
}

/**
 * Assign `value` into `target` at a dot-delimited path, creating intermediate
 * objects as needed. Enables `-F branch.name=dev` → `{ branch: { name: "dev" } }`,
 * matching the nested shape of Neon request bodies.
 */
export function setDeep(
	target: Record<string, unknown>,
	dottedKey: string,
	value: unknown,
): void {
	const parts = dottedKey.split(".");
	let node = target;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		const next = node[part];
		if (typeof next !== "object" || next === null || Array.isArray(next)) {
			node[part] = {};
		}
		node = node[part] as Record<string, unknown>;
	}
	node[parts[parts.length - 1]] = value;
}

/** Build a JSON body object from typed `-F` and string `-f` field pairs. */
export function buildBody(
	fields: string[],
	rawFields: string[],
): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	for (const field of fields) {
		const { key, value } = parseKeyValue(field);
		setDeep(body, key, parseTypedValue(value));
	}
	for (const field of rawFields) {
		const { key, value } = parseKeyValue(field);
		setDeep(body, key, value);
	}
	return body;
}

/** Build a query-string map from `-Q key=value` pairs. */
export function buildQuery(pairs: string[]): Record<string, string> {
	const query: Record<string, string> = {};
	for (const pair of pairs) {
		const { key, value } = parseKeyValue(pair);
		query[key] = value;
	}
	return query;
}

/** Build a header map from `-H key:value` pairs. */
export function parseHeaders(pairs: string[]): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const pair of pairs) {
		const idx = pair.indexOf(":");
		if (idx === -1) {
			throw new Error(`Invalid header "${pair}". Expected "key:value".`);
		}
		headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
	}
	return headers;
}

function assertMethod(method: string): asserts method is HttpMethod {
	if (!(HTTP_METHODS as readonly string[]).includes(method)) {
		throw new Error(
			`Unsupported method "${method}". Use one of: ${HTTP_METHODS.join(", ")}.`,
		);
	}
}

const JSON_TOKEN =
	/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Color the tokens of serialized JSON without changing a byte of the text itself. */
export function colorizeJson(json: string): string {
	return json.replace(JSON_TOKEN, (token, string, colon, bool) => {
		if (string !== undefined) {
			return colon !== undefined
				? `${chalk.cyan(string)}${colon}`
				: chalk.green(string);
		}
		if (bool !== undefined) {
			return chalk.magenta(token);
		}
		if (token === "null") {
			return chalk.dim(token);
		}
		return chalk.yellow(token);
	});
}

const METHOD_COLORS: Record<string, (text: string) => string> = {
	GET: chalk.green,
	POST: chalk.cyan,
	PUT: chalk.yellow,
	PATCH: chalk.yellow,
	DELETE: chalk.red,
};

// ── I/O helpers ──────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks as unknown as readonly Uint8Array[]).toString(
		"utf8",
	);
}

/** Resolve `--data`: `-` reads stdin, `@file` reads a file, else the literal string. Parsed as JSON when possible. */
async function readData(data: string): Promise<unknown> {
	let raw: string;
	if (data === "-") {
		raw = await readStdin();
	} else if (data.startsWith("@")) {
		raw = readFileSync(resolve(data.slice(1)), "utf8");
	} else {
		raw = data;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

// ── yargs command ─────────────────────────────────────────────────────────────

type ApiArgs = CommonProps & {
	configDir: string;
	path?: string;
	method?: string;
	field?: (string | number)[];
	rawField?: (string | number)[];
	data?: string;
	query?: (string | number)[];
	header?: (string | number)[];
	include: boolean;
	list: boolean;
	describe: boolean;
	refresh: boolean;
	specUrl: string;
	color?: boolean;
};

const toStrings = (values?: (string | number)[]): string[] =>
	(values ?? []).map(String);

async function listEndpoints(args: ApiArgs): Promise<void> {
	const spec = await loadSpec({
		configDir: args.configDir,
		specUrl: args.specUrl,
		refresh: args.refresh,
	});
	if (!spec) {
		throw new Error(
			`Could not load the Neon OpenAPI spec from ${args.specUrl}. ` +
				"Check your network connection or pass --spec-url.",
		);
	}
	const endpoints = getEndpoints(spec).map((endpoint) => ({
		method: endpoint.method,
		path: endpoint.path,
		summary: endpoint.summary ?? "",
	}));
	writer(args).end(endpoints, {
		fields: ["method", "path", "summary"],
		title: `Neon API endpoints (${endpoints.length})`,
		emptyMessage: "No endpoints found in the spec.",
		renderColumns: {
			method: (endpoint) =>
				useColor(args)
					? (METHOD_COLORS[endpoint.method] ?? String)(
							endpoint.method,
						)
					: endpoint.method,
		},
	});
}

function isListing(args: ApiArgs): boolean {
	return args.list || args.path === "list" || args.path === "ls";
}

function describeType(field: {
	type: string;
	enum?: unknown[];
	items?: {
		type: string;
		enum?: unknown[];
		properties?: { name: string; enum?: unknown[] }[];
	};
}): string {
	const enumText = (values: unknown[] | undefined): string =>
		Array.isArray(values) && values.length > 0
			? ` (${values.map(String).join(", ")})`
			: "";
	if (field.type === "array" && field.items) {
		const props = field.items.properties;
		if (props && props.length > 0) {
			const inner = props
				.map((prop) => `${prop.name}${enumText(prop.enum)}`)
				.join(", ");
			return `array (${inner})`;
		}
		return `array of ${field.items.type}${enumText(field.items.enum)}`;
	}
	return `${field.type}${enumText(field.enum)}`;
}

async function describeRoute(args: ApiArgs): Promise<void> {
	const path = args.path;
	if (!path) {
		throw new Error(
			"Missing API path. Usage: neon api <path> --describe " +
				"(e.g. neon api /projects --describe). " +
				"Run `neon api --list` to see available routes.",
		);
	}
	if (!path.startsWith("/")) {
		throw new Error(
			`Invalid path "${path}". API paths must start with "/". ` +
				"Run `neon api --list` to see available routes.",
		);
	}
	const unused = [
		...toStrings(args.field),
		...toStrings(args.rawField),
		...toStrings(args.query),
		...toStrings(args.header),
	];
	if (unused.length > 0 || args.data !== undefined || args.include) {
		throw new Error(
			"--describe prints the field list; it does not send a request. " +
				"Drop -F, -f, -d, -Q, -H, and -i.",
		);
	}
	const spec = await loadSpec({
		configDir: args.configDir,
		specUrl: args.specUrl,
		refresh: args.refresh,
	});
	if (!spec) {
		throw new Error(
			`Could not load the Neon OpenAPI spec from ${args.specUrl}. ` +
				"Check your network connection or pass --spec-url.",
		);
	}
	const method = String(args.method ?? "GET").toUpperCase();
	assertMethod(method);
	const description = describeOperation(spec, path, method);
	const endpoint = {
		method: description.method,
		path: description.path,
		summary: description.summary,
		operationId: description.operationId,
		bodyRequired: description.bodyRequired,
		...(description.contentType !== "" &&
		description.contentType !== "application/json"
			? { contentType: description.contentType }
			: {}),
	};
	let title = description.summary
		? `${description.method} ${description.path} - ${description.summary}`
		: `${description.method} ${description.path}`;
	if (description.bodyRequired) {
		title = `${title} (body required)`;
	}
	if (
		description.contentType !== "" &&
		description.contentType !== "application/json"
	) {
		title = `${title} (${description.contentType})`;
	}
	if (args.output === "json" || args.output === "yaml") {
		writer(args)
			.write(endpoint, {
				fields: [
					"method",
					"path",
					"summary",
					"operationId",
					"bodyRequired",
				],
				title: "Endpoint",
			})
			.end(description.fields, {
				fields: ["in", "name", "required", "type", "description"],
				title: "Parameters",
			});
		return;
	}
	writer(args).end(description.fields, {
		fields: ["in", "name", "required", "type", "description"],
		title,
		emptyMessage: "No path, query, or body fields in the spec.",
		renderColumns: {
			required: (field) => (field.required ? "required" : "optional"),
			type: (field) => describeType(field),
		},
	});
}

async function runRequest(args: ApiArgs): Promise<void> {
	const path = args.path;
	if (!path) {
		throw new Error(
			"Missing API path. Usage: neon api <path> (e.g. neon api /projects). " +
				"Run `neon api --list` to see available routes.",
		);
	}
	if (!path.startsWith("/")) {
		throw new Error(
			`Invalid path "${path}". API paths must start with "/". ` +
				"Run `neon api --list` to see available routes.",
		);
	}

	const fields = toStrings(args.field);
	const rawFields = toStrings(args.rawField);

	let body: unknown;
	if (args.data !== undefined) {
		body = await readData(args.data);
	} else if (fields.length > 0 || rawFields.length > 0) {
		body = buildBody(fields, rawFields);
	}

	const hasBody = body !== undefined;
	const method = String(
		args.method ?? (hasBody ? "POST" : "GET"),
	).toUpperCase();
	assertMethod(method);

	const query = buildQuery(toStrings(args.query));
	const headers = parseHeaders(toStrings(args.header));

	const params: RequestParams = {
		path,
		method,
		...(Object.keys(query).length > 0 ? { query } : {}),
		...(hasBody ? { body } : {}),
		...(Object.keys(headers).length > 0 ? { headers } : {}),
	};

	let response: Awaited<ReturnType<typeof args.apiClient.request>>;
	try {
		response = await args.apiClient.request(params);
	} catch (err) {
		// 401 and SSO responses may be recovered and retried; printing them would put
		// two responses on stdout for one successful call.
		if (
			args.include &&
			isNeonApiError(err) &&
			err.status !== undefined &&
			err.status !== 401 &&
			!isSsoCode(codeFromBody(err.data))
		) {
			await writeResponse(args, {
				status: err.status,
				statusText: err.statusText ?? "",
				headers: err.headers ?? {},
				data: err.data,
			});
		}
		throw err;
	}
	await writeResponse(args, response);
}

const isSsoCode = (code: string | undefined) =>
	code === "SSO_AUTHORIZATION_REQUIRED" || code === "SSO_ORG_CREDS_ONLY";

/** Pipes stay plain regardless of FORCE_COLOR, so `neon api … | jq` never sees escapes. */
const useColor = (args: ApiArgs): boolean =>
	process.stdout.isTTY === true &&
	args.color !== false &&
	!process.env.NO_COLOR &&
	chalk.level > 0;

/** Resolves once stdout has taken the text, so a following `process.exit` can't cut it off. */
async function writeResponse(
	args: ApiArgs,
	response: {
		status: number;
		statusText: string;
		headers: Record<string, string>;
		data: unknown;
	},
): Promise<void> {
	const color = useColor(args);
	let text = "";
	if (args.include) {
		const status = `HTTP ${response.status} ${response.statusText}`;
		const statusColor = response.status < 400 ? chalk.green : chalk.red;
		text += `${color ? statusColor.bold(status) : status}\n`;
		for (const [key, value] of Object.entries(response.headers)) {
			text += `${color ? chalk.cyan(key) : key}: ${value}\n`;
		}
		text += "\n";
	}
	if (response.data !== undefined) {
		if (args.output === "yaml") {
			text += YAML.stringify(response.data);
		} else {
			const json = JSON.stringify(response.data, null, 2);
			text += `${color ? colorizeJson(json) : json}\n`;
		}
	}
	if (text === "") {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
	});
}

export const command = "api [path]";
export const describe =
	"Call any Neon API route directly (authenticated passthrough)";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 api <path> [options]")
		.positional("path", {
			type: "string",
			describe:
				'API path beginning with "/" (e.g. /projects or ' +
				"/projects/{project_id}/branches). Use `list` to list endpoints.",
		})
		.options({
			method: {
				alias: "X",
				type: "string",
				describe:
					"HTTP method (GET, POST, PUT, PATCH, DELETE). " +
					"Defaults to GET, or POST when a body is provided.",
			},
			field: {
				alias: "F",
				type: "array",
				string: true,
				describe:
					"Body field key=value (repeatable). Dot-notation nests " +
					"objects (e.g. -F branch.name=dev); values are typed " +
					"(numbers, booleans, null, JSON).",
			},
			"raw-field": {
				alias: "f",
				type: "array",
				string: true,
				describe:
					"Body field key=value with the value kept as a raw string.",
			},
			data: {
				alias: "d",
				type: "string",
				describe:
					"Raw request body: a JSON string, @file, or - for stdin. " +
					"Overrides --field.",
			},
			query: {
				alias: "Q",
				type: "array",
				string: true,
				describe: "Query parameter key=value (repeatable).",
			},
			header: {
				alias: "H",
				type: "array",
				string: true,
				describe: "Extra request header key:value (repeatable).",
			},
			include: {
				alias: "i",
				type: "boolean",
				default: false,
				describe:
					"Print the response status and headers before the body.",
			},
			list: {
				type: "boolean",
				default: false,
				describe: "List available API endpoints from the OpenAPI spec.",
			},
			describe: {
				type: "boolean",
				default: false,
				describe:
					"Print path, query, and body fields from the OpenAPI spec without calling the API. Body names are dotted for -F.",
			},
			refresh: {
				type: "boolean",
				default: false,
				describe:
					"Refresh the cached OpenAPI spec (used with --list and --describe).",
			},
			"spec-url": {
				type: "string",
				default: process.env.NEON_API_SPEC_URL ?? DEFAULT_SPEC_URL,
				hidden: true,
				describe: "OpenAPI spec URL used by --list and --describe.",
			},
		})
		.example("$0 api /projects", "List your projects")
		.example(
			"$0 api /projects/{id}/branches -X POST -F branch.name=dev",
			"Create a branch",
		)
		.example("$0 api --list", "List every available API route")
		.example(
			"$0 api /projects --describe",
			"Show GET /projects query parameters",
		)
		.example(
			"$0 api /projects -X POST --describe",
			"Show the create-project body fields",
		);

export const handler = async (args: yargs.Arguments) => {
	const apiArgs = args as unknown as ApiArgs;
	if (isListing(apiArgs) && apiArgs.describe) {
		throw new Error("Pass either --list or --describe, not both.");
	}
	if (isListing(apiArgs)) {
		await listEndpoints(apiArgs);
		return;
	}
	if (apiArgs.describe) {
		await describeRoute(apiArgs);
		return;
	}
	await runRequest(apiArgs);
};
