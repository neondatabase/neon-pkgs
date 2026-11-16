// Writes src/generated/output.gen.ts: a Zod schema for every OpenAPI component,
// shaped like the data tools return rather than the wire format.
//
// - Objects are loose, so a field the API adds later still parses.
// - Optional fields are nullish: tool results turn `undefined` into `null`.
// - Enums and formats are plain strings, so a new value still parses.
// - Binary fields are the `{ base64, contentType, size }` object results carry.
// - `allOf` parts are merged into one object.
// - Spec descriptions are left out: MCP clients get these schemas on every
//   listing, and the field names carry the meaning. Hand-written tools describe
//   their own fields.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, "../../sdk/spec/neon-openapi.json");
const outPath = resolve(here, "../src/generated/output.gen.ts");
const document = JSON.parse(readFileSync(specPath, "utf8"));
const components = document.components.schemas;

const refName = (reference) => {
	if (!reference.startsWith("#/components/schemas/")) {
		throw new Error(`Unsupported reference: ${reference}`);
	}
	return reference.slice("#/components/schemas/".length);
};

const key = (name) =>
	/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);

// Components referenced before they are declared, or in a cycle, are read lazily.
const declared = new Set();

const reference = (name) =>
	declared.has(name) ? name : `z.lazy(() => ${name})`;

const isNullable = (node) =>
	node.nullable === true ||
	(Array.isArray(node.type) && node.type.includes("null"));

const baseType = (node) =>
	Array.isArray(node.type) ? node.type.find((t) => t !== "null") : node.type;

const resolveNode = (node) =>
	node.$ref === undefined ? node : components[refName(node.$ref)];

// The properties and required list of an object, with `allOf` parts merged.
const objectParts = (node) => {
	const properties = { ...(node.properties ?? {}) };
	const required = new Set(node.required ?? []);
	for (const part of node.allOf ?? []) {
		const merged = objectParts(resolveNode(part));
		Object.assign(properties, merged.properties);
		for (const name of merged.required) required.add(name);
	}
	return { properties, required };
};

const objectExpression = (node) => {
	const { properties, required } = objectParts(node);
	const names = Object.keys(properties);
	const additional = node.additionalProperties;
	if (names.length === 0) {
		return typeof additional === "object"
			? `z.record(z.string(), ${expression(additional)})`
			: "z.record(z.string(), z.unknown())";
	}
	const fields = names.map((name) => {
		const field = properties[name];
		const value = expression(field);
		return `${key(name)}: ${required.has(name) ? value : `${value}.nullish()`}`;
	});
	return `z.looseObject({ ${fields.join(", ")} })`;
};

function expression(node) {
	if (node.$ref !== undefined) {
		return reference(refName(node.$ref));
	}
	const options = node.oneOf ?? node.anyOf;
	let result;
	if (options !== undefined) {
		const members = options
			.filter((option) => baseType(option) !== "null")
			.map(expression);
		result =
			members.length === 1 ? members[0] : `z.union([${members.join(", ")}])`;
	} else if (
		node.allOf?.length === 1 &&
		node.properties === undefined &&
		baseType(resolveNode(node.allOf[0])) !== "object"
	) {
		// `allOf` around one scalar ref only adds `nullable` or a description.
		result = expression(node.allOf[0]);
	} else if (node.allOf !== undefined || node.properties !== undefined) {
		result = objectExpression(node);
	} else {
		switch (baseType(node)) {
			case "object":
				result = objectExpression(node);
				break;
			case "array":
				result = `z.array(${node.items === undefined ? "z.unknown()" : expression(node.items)})`;
				break;
			case "string":
				result =
					node.format === "binary"
						? "z.looseObject({ base64: z.string(), contentType: z.string(), size: z.number() })"
						: "z.string()";
				break;
			case "integer":
			case "number":
				result = "z.number()";
				break;
			case "boolean":
				result = "z.boolean()";
				break;
			default:
				result = "z.unknown()";
		}
	}
	return isNullable(node) ? `${result}.nullable()` : result;
}

// Components another component refers to, so each can be declared after them.
const dependencies = (node, found = new Set()) => {
	if (node === null || typeof node !== "object") return found;
	if (typeof node.$ref === "string") {
		found.add(refName(node.$ref));
		return found;
	}
	for (const value of Object.values(node)) dependencies(value, found);
	return found;
};

const order = [];
const visiting = new Set();
const cyclic = new Set();
const visit = (name) => {
	if (declaredOrder.has(name)) return;
	if (visiting.has(name)) {
		cyclic.add(name);
		return;
	}
	visiting.add(name);
	for (const dependency of dependencies(components[name])) visit(dependency);
	visiting.delete(name);
	declaredOrder.add(name);
	order.push(name);
};
const declaredOrder = new Set();
for (const name of Object.keys(components)) visit(name);

// A component in a cycle needs an explicit type: TypeScript can't infer it.
const declarations = order.map((name) => {
	const node = components[name];
	const annotation = cyclic.has(name) ? ": z.ZodType" : "";
	const source = `export const ${name}${annotation} = ${expression(node)};`;
	declared.add(name);
	return source;
});

writeFileSync(
	outPath,
	`// This file is auto-generated by scripts/generate-outputs.mjs. Do not edit.

import * as z from "zod";

${declarations.join("\n\n")}
`,
);
