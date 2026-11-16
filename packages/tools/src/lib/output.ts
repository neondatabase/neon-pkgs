import * as z from "zod";

declare const outputData: unique symbol;

/**
 * A tool's `outputSchema`. The phantom `Data` is the schema of `execute(...).data`,
 * so definitions can check at compile time that the schema accepts the result.
 */
export type NeonOutputSchema<Data extends z.ZodType = z.ZodType> =
	z.ZodObject & { readonly [outputData]?: Data };

/** `data` of a call whose response has no body: `null`, or whatever object the API sent anyway. */
export const noContent = z.looseObject({}).nullable();

/** `data` of a binary response, as `JsonSafe` encodes a `Blob`. */
export const jsonSafeBlob = z.strictObject({
	base64: z.string(),
	contentType: z.string(),
	size: z.number(),
});

const dataSchemas = new WeakMap<z.ZodObject, z.ZodType>();
const credentials = new WeakSet<z.ZodType>();

const isObjectSchema = (schema: z.ZodType): schema is z.ZodObject =>
	schema instanceof z.ZodObject;

/**
 * One object accepting every option's fields. A union has no `type: "object"`
 * root, which MCP requires, so options become alternatives per field.
 */
const mergeObjectUnion = (options: readonly z.ZodObject[]): z.ZodObject => {
	const names = new Set(
		options.flatMap((option) => Object.keys(option.shape)),
	);
	const shape: Record<string, z.ZodType> = {};
	for (const name of names) {
		const fields = options.map(
			(option) => option.shape[name] as z.ZodType | undefined,
		);
		const present = fields.filter(
			(field): field is z.ZodType => field !== undefined,
		);
		const unique = [...new Set(present)];
		const [first, ...rest] = unique;
		if (first === undefined) continue;
		const field = rest.length === 0 ? first : z.union([first, ...rest]);
		const optional =
			present.length < options.length ||
			present.some((option) => option.safeParse(undefined).success);
		const merged =
			optional && !(field instanceof z.ZodOptional)
				? field.optional()
				: field;
		if (present.some((option) => credentials.has(option))) {
			credentials.add(merged);
		}
		shape[name] = merged;
	}
	return z.looseObject(shape);
};

/** `schema.partial()`, keeping fields that are already optional, credentials among them. */
const partial = (schema: z.ZodObject): z.ZodObject =>
	schema.extend(
		Object.fromEntries(
			Object.entries(schema.shape as Record<string, z.ZodType>).map(
				([name, field]) => [
					name,
					field instanceof z.ZodOptional ? field : field.optional(),
				],
			),
		),
	);

const structuredSchema = (data: z.ZodType): z.ZodObject => {
	if (isObjectSchema(data)) return data;
	if (data instanceof z.ZodNullable) {
		const inner = data.unwrap() as z.ZodType;
		return partial(structuredSchema(inner));
	}
	if (
		data instanceof z.ZodUnion &&
		data.options.every((option) => isObjectSchema(option as z.ZodType))
	) {
		return mergeObjectUnion(data.options as z.ZodObject[]);
	}
	if (data instanceof z.ZodArray) return z.strictObject({ items: data });
	if (data instanceof z.ZodNull) return z.strictObject({});
	return z.strictObject({ value: data });
};

/**
 * The `outputSchema` of a tool whose `data` matches `data`: the schema of
 * {@link toStructuredContent}`(data)`.
 */
export const outputSchemaFor = <const Data extends z.ZodType>(
	data: Data,
): NeonOutputSchema<Data> => {
	const structured = structuredSchema(data);
	if (structured !== (data as z.ZodType)) dataSchemas.set(structured, data);
	return structured;
};

/** The schema of `execute(...).data` behind an `outputSchema`. */
export const outputDataSchema = (outputSchema: z.ZodObject): z.ZodType =>
	dataSchemas.get(outputSchema) ?? outputSchema;

/**
 * A tool's `data` as the JSON object its `outputSchema` describes, for MCP
 * `structuredContent`: an object as is, an array as `{ items }`, `null` as `{}`,
 * and a string, number, or boolean as `{ value }`.
 */
export const toStructuredContent = (data: unknown): Record<string, unknown> => {
	if (Array.isArray(data)) return { items: data };
	if (data === null || data === undefined) return {};
	if (typeof data === "object") return data as Record<string, unknown>;
	return { value: data };
};

/**
 * An optional result field that carries a credential, such as a password or a
 * connection URI. A host that strips credentials from results can drop exactly
 * these with {@link withoutCredentials}.
 */
export const credential = <const Field extends z.ZodType>(field: Field) => {
	const optional = field.nullish();
	credentials.add(optional);
	return optional;
};

/** Whether `field` was declared with {@link credential}. */
export const isCredential = (field: z.ZodType): boolean =>
	credentials.has(field);

type OmitField = (name: string, field: z.ZodType) => boolean;

const omitFields = (
	schema: z.ZodType,
	omit: OmitField,
	seen: Map<z.ZodType, z.ZodType>,
): z.ZodType => {
	const cached = seen.get(schema);
	if (cached !== undefined) return cached;
	let next: z.ZodType = schema;
	if (schema instanceof z.ZodObject) {
		const shape: Record<string, z.ZodType> = {};
		for (const [name, field] of Object.entries(
			schema.shape as Record<string, z.ZodType>,
		)) {
			if (!omit(name, field)) shape[name] = omitFields(field, omit, seen);
		}
		const catchall = schema.def.catchall as z.ZodType | undefined;
		next =
			catchall === undefined
				? z.object(shape)
				: z.object(shape).catchall(omitFields(catchall, omit, seen));
	} else if (schema instanceof z.ZodArray) {
		next = z.array(omitFields(schema.element as z.ZodType, omit, seen));
	} else if (schema instanceof z.ZodOptional) {
		next = omitFields(schema.unwrap() as z.ZodType, omit, seen).optional();
	} else if (schema instanceof z.ZodNullable) {
		next = omitFields(schema.unwrap() as z.ZodType, omit, seen).nullable();
	} else if (schema instanceof z.ZodUnion) {
		const options = (schema.options as z.ZodType[]).map((option) =>
			omitFields(option, omit, seen),
		);
		next = z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]]);
	} else if (schema instanceof z.ZodRecord) {
		next = z.record(
			schema.keyType as z.ZodString,
			omitFields(schema.valueType as z.ZodType, omit, seen),
		);
	}
	seen.set(schema, next);
	return next;
};

const omitOutputFields = (
	outputSchema: z.ZodObject,
	omit: OmitField,
): z.ZodObject => {
	const next = omitFields(outputSchema, omit, new Map());
	if (!isObjectSchema(next)) {
		throw new TypeError("Expected an object output schema");
	}
	const data = dataSchemas.get(outputSchema);
	if (data !== undefined) {
		dataSchemas.set(next, omitFields(data, omit, new Map()));
	}
	return next;
};

/**
 * `outputSchema` without its {@link credential} fields at any depth, for a host
 * that strips them from results. Those fields are optional, so the original
 * schema accepts a stripped result too; this one also stops advertising them.
 */
export const withoutCredentials = (outputSchema: z.ZodObject): z.ZodObject =>
	omitOutputFields(outputSchema, (_name, field) => credentials.has(field));

/** `outputSchema` without the named fields at any depth. */
export const withoutOutputFields = (
	outputSchema: z.ZodObject,
	fields: Iterable<string>,
): z.ZodObject => {
	const names = new Set(fields);
	return omitOutputFields(outputSchema, (name) => names.has(name));
};
