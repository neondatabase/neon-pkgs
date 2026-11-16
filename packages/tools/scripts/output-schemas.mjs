// Zod schemas for what each operation's `invoke` resolves to: the success
// response body, parsed as JSON. They are written for reading results, so they
// differ from the request schemas on purpose: objects are loose because the API
// adds fields, enums are plain strings because it adds values, range and
// pattern constraints are dropped because a result is never rejected for them,
// and an optional field also accepts null, as the published `JsonSafe` type of
// every tool result already declares.

/** Fields that carry a credential, by component. They are emitted with `credential()`. */
const credentialFields = {
	ApiKeyCreateResponse: ["key"],
	ConnectionDetails: ["connection_uri"],
	ConnectionParameters: ["password"],
	ConnectionURIResponse: ["uri"],
	ConnectionURIsOptionalResponse: ["connection_uris"],
	ConnectionURIsResponse: ["connection_uris"],
	CreateCredentialResponse: ["api_token", "s3_secret_access_key"],
	CredentialSecret: ["api_token", "s3_secret_access_key"],
	NeonAuthCreateIntegrationResponse: ["secret_server_key"],
	NeonAuthOAuthClientCreated: ["client_secret"],
	NeonAuthOAuthClientSecret: ["client_secret"],
	NeonAuthOauthProvider: ["client_secret"],
	RealtimeSecret: ["secret"],
	Role: ["password"],
	RolePasswordResponse: ["password"],
	RotateCredentialResponse: ["api_token", "s3_secret_access_key"],
	StandardEmailServerResponse: ["password"],
};

const componentName = (reference) => {
	const match = /^#\/components\/schemas\/([^/]+)$/.exec(reference);
	if (!match) throw new Error(`Unsupported response schema reference: ${reference}`);
	return match[1];
};

/**
 * @param {object} document OpenAPI document
 * @param {(value: unknown) => any} dereference resolves a non-schema `$ref`
 * @param {{ credentials?: Record<string, string[]> }} [options] credential fields by component
 */
export const generateOutputSchemas = (
	document,
	dereference,
	{ credentials = credentialFields } = {},
) => {
	const components = document.components?.schemas ?? {};
	const emitted = new Map();
	const order = [];
	const unusedCredentials = new Set(
		Object.entries(credentials).flatMap(([component, fields]) =>
			fields.map((field) => `${component}.${field}`),
		),
	);

	const constName = (name) => `z${name.replace(/[^A-Za-z0-9]/g, "")}`;

	const component = (name, stack = []) => {
		if (emitted.has(name)) return emitted.get(name);
		if (stack.includes(name)) {
			throw new Error(
				`Recursive response schema ${[...stack, name].join(" > ")} needs z.lazy support.`,
			);
		}
		const schema = components[name];
		if (!schema) throw new Error(`Unknown response schema component: ${name}`);
		const expression = schemaExpression(schema, [...stack, name], name);
		const identifier = constName(name);
		emitted.set(name, identifier);
		order.push(`export const ${identifier} = ${expression};`);
		return identifier;
	};

	const resolve = (schema) =>
		schema?.$ref ? components[componentName(schema.$ref)] : schema;

	const objectParts = (schema, parts = []) => {
		const resolved = resolve(schema);
		if (!resolved || typeof resolved !== "object") return parts;
		if (resolved.allOf) {
			for (const part of resolved.allOf) objectParts(part, parts);
		}
		if (resolved.properties || resolved.additionalProperties !== undefined) {
			parts.push({
				owner: schema?.$ref ? componentName(schema.$ref) : undefined,
				schema: resolved,
			});
		}
		return parts;
	};

	const objectExpression = (schema, stack, owner) => {
		const parts = objectParts(schema);
		const properties = new Map();
		const required = new Set();
		let additional;
		for (const part of parts) {
			const partOwner = part.owner ?? owner;
			for (const [name, property] of Object.entries(
				part.schema.properties ?? {},
			)) {
				properties.set(name, { property, owner: partOwner });
			}
			for (const name of part.schema.required ?? []) required.add(name);
			if (
				part.schema.additionalProperties &&
				typeof part.schema.additionalProperties === "object"
			) {
				additional = part.schema.additionalProperties;
			}
		}
		if (properties.size === 0 && additional) {
			return `z.record(z.string(), ${schemaExpression(additional, stack)})`;
		}
		const fields = [...properties].map(([name, { property, owner: field }]) => {
			const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
			const expression = schemaExpression(property, stack);
			if (isCredential(field, name)) {
				unusedCredentials.delete(`${field}.${name}`);
				return `${key}: credential(${expression})`;
			}
			if (required.has(name)) return `${key}: ${expression}`;
			const nonNull = expression.endsWith(".nullable()")
				? expression.slice(0, -".nullable()".length)
				: expression;
			return `${key}: ${nonNull}.nullish()`;
		});
		const object = `z.looseObject({ ${fields.join(", ")} })`;
		return additional
			? `${object}.catchall(${schemaExpression(additional, stack)})`
			: object;
	};

	const isCredential = (owner, name) =>
		owner !== undefined && credentials[owner]?.includes(name) === true;

	const schemaExpression = (schema, stack, owner) => {
		if (schema === true || schema === undefined) return "z.unknown()";
		if (schema.$ref) return component(componentName(schema.$ref), stack);
		const nullable = schema.nullable === true ? ".nullable()" : "";
		if (schema.oneOf || schema.anyOf) {
			const options = (schema.oneOf ?? schema.anyOf).map((option) =>
				schemaExpression(option, stack),
			);
			return `z.union([${options.join(", ")}])${nullable}`;
		}
		if (schema.allOf) {
			const [only] = schema.allOf;
			if (schema.allOf.length === 1 && !schema.properties && only.$ref) {
				return `${schemaExpression(only, stack)}${nullable}`;
			}
			return `${objectExpression(schema, stack, owner)}${nullable}`;
		}
		if (
			schema.type === "object" ||
			schema.properties ||
			schema.additionalProperties !== undefined
		) {
			return `${objectExpression(schema, stack, owner)}${nullable}`;
		}
		switch (schema.type) {
			case "array":
				return `z.array(${schemaExpression(schema.items, stack)})${nullable}`;
			case "string":
				if (schema.format === "binary") {
					throw new Error("Binary response fields are not supported yet.");
				}
				return schema.enum?.length === 1
					? `z.literal(${JSON.stringify(schema.enum[0])})${nullable}`
					: `z.string()${nullable}`;
			case "integer":
			case "number":
				return `z.number()${nullable}`;
			case "boolean":
				return `z.boolean()${nullable}`;
			case undefined:
				return `z.unknown()`;
			default:
				throw new Error(`Unsupported response schema type: ${schema.type}`);
		}
	};

	const successResponses = (operation) =>
		Object.entries(operation.responses ?? {})
			.filter(([status]) => /^2\d\d$/.test(status))
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([status, response]) => ({ status, response: dereference(response) }));

	const bodyExpression = (operationId, content) => {
		const types = Object.keys(content ?? {});
		if (types.length === 0) return undefined;
		if (types.length > 1) {
			throw new Error(
				`${operationId} has several success content types: ${types.join(", ")}`,
			);
		}
		const [type] = types;
		if (type === "application/json") {
			return schemaExpression(content[type].schema, [], undefined);
		}
		if (content[type].schema?.format === "binary") return "jsonSafeBlob";
		throw new Error(`${operationId} has an unsupported success content type: ${type}`);
	};

	/** The data schema of one operation's `invoke` result. */
	const outputFor = (operationId, operation) => {
		const responses = successResponses(operation);
		if (responses.length === 0) {
			throw new Error(`${operationId} declares no success response`);
		}
		const bodies = responses.map(({ response }) =>
			bodyExpression(operationId, response.content),
		);
		const typed = [...new Set(bodies.filter((body) => body !== undefined))];
		if (typed.length > 1) {
			throw new Error(`${operationId} has several success response bodies`);
		}
		const [body] = typed;
		if (body === undefined) return "noContent";
		return bodies.includes(undefined) ? `${body}.nullable()` : body;
	};

	const finish = (entries) => {
		if (unusedCredentials.size > 0) {
			throw new Error(
				`Credential fields not found in any response schema: ${[...unusedCredentials].join(", ")}`,
			);
		}
		return `// This file is auto-generated by scripts/generate-tools.mjs. Do not edit.
// Schemas of each operation's success response, for tool output schemas.

import * as z from "zod";
import { credential, jsonSafeBlob, noContent } from "../lib/output.js";

${order.join("\n\n")}

/** The data schema of each operation's result, by operation id. */
export const operationOutputs = {
${entries.map(([operationId, expression]) => `\t${operationId}: ${expression},`).join("\n")}
} as const;
`;
	};

	return { outputFor, finish };
};
