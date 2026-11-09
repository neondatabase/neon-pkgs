import * as z from "zod";
import { isNeonToolId, type NeonToolId } from "./ergonomic/ids.js";

const REFERENCE = /\{\{([^{}]*)\}\}/g;

export type ToolNameOf = (selector: NeonToolId) => string;

/** The selectors a description names as `{{selector}}`. */
export const toolReferences = (text: string): string[] =>
	[...text.matchAll(REFERENCE)].map((match) => match[1]);

/** Replaces each `{{selector}}` with the name that tool publishes under. */
export const resolveToolReferences = (
	text: string,
	nameOf: ToolNameOf,
	where: string,
): string =>
	text.replace(REFERENCE, (_token, selector: string) => {
		if (!isNeonToolId(selector)) {
			throw new TypeError(
				`Unknown Neon tool reference "{{${selector}}}" in ${where}`,
			);
		}
		return nameOf(selector);
	});

const fieldDescription = (field: z.core.$ZodType): string | undefined => {
	const description = z.globalRegistry.get(field)?.description;
	if (description !== undefined) return description;
	if (
		field instanceof z.ZodOptional ||
		field instanceof z.ZodNullable ||
		field instanceof z.ZodDefault
	) {
		return fieldDescription(field.unwrap());
	}
	return undefined;
};

/** Resolves references in the descriptions of an object schema's top-level fields. */
export const resolveInputReferences = (
	schema: z.ZodType,
	nameOf: ToolNameOf,
	where: string,
): z.ZodType => {
	if (!(schema instanceof z.ZodObject)) return schema;
	const resolved: Record<string, z.ZodType> = {};
	for (const [name, field] of Object.entries(schema.shape)) {
		const description = fieldDescription(field);
		if (description === undefined || !description.includes("{{")) continue;
		resolved[name] = field.describe(
			resolveToolReferences(description, nameOf, `${where}.${name}`),
		);
	}
	return Object.keys(resolved).length === 0
		? schema
		: schema.safeExtend(resolved);
};
