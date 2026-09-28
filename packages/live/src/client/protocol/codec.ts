import type { ClientMessage, ServerMessage } from "./messages.js";
import {
	validateClientMessage as generatedClientMessageValidator,
	validateServerMessage as generatedServerMessageValidator,
	neonLiveSchemaPatterns,
} from "./schema-validator.gen.js";

const MAX_SERVER_MESSAGE_BYTES = 1024 * 1024;
const UTF8 = new TextEncoder();

interface SchemaValidationError {
	readonly instancePath: string;
	readonly schemaPath: string;
	readonly keyword: string;
	readonly params: Record<string, unknown>;
	readonly message?: string;
}

interface SchemaValidator {
	(value: unknown): boolean;
	readonly errors: readonly SchemaValidationError[] | null;
}

type WireRecord = Record<string, unknown>;

const validateClientMessage =
	generatedClientMessageValidator as unknown as SchemaValidator;
const validateServerMessage =
	generatedServerMessageValidator as unknown as SchemaValidator;

export class ProtocolError extends Error {
	constructor(message: string) {
		super(`Invalid Neon Live protocol message: ${message}`);
		this.name = "ProtocolError";
	}
}

export interface DecodedServerFrame {
	readonly message: ServerMessage;
	readonly byteLength: number;
}

/** Serialize one validated client command to a WebSocket text frame. */
export function encodeClientMessage(message: ClientMessage): string {
	assertSchema(validateClientMessage, message);
	validateClientUtf8Limits(message as WireRecord);
	return JSON.stringify(message);
}

/** Parse and strictly validate one server WebSocket text frame. */
export function decodeServerMessage(text: string): ServerMessage {
	return decodeServerFrame(text).message;
}

/** Decode a server frame and retain its exact UTF-8 size for staging limits. */
export function decodeServerFrame(text: string): DecodedServerFrame {
	const byteLength = utf8ByteLength(text);
	if (byteLength > MAX_SERVER_MESSAGE_BYTES) {
		throw new ProtocolError("message exceeds the byte limit");
	}

	// JSON.parse silently keeps the last duplicate member, so inspect the source
	// before parsing and before the generated structural validator sees it.
	try {
		rejectDuplicateKeys(text);
	} catch (error) {
		if (error instanceof ProtocolError) throw error;
		throw new ProtocolError("not valid JSON");
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new ProtocolError("not valid JSON");
	}

	assertSchema(validateServerMessage, value);
	const message = value as ServerMessage;
	validateServerUtf8Limits(message as WireRecord);
	return Object.freeze({ message: freezeWireValue(message), byteLength });
}

function freezeWireValue<Value>(value: Value): Value {
	if (value === null || typeof value !== "object" || Object.isFrozen(value))
		return value;
	for (const child of Object.values(value)) freezeWireValue(child);
	return Object.freeze(value);
}

function assertSchema(validator: SchemaValidator, value: unknown): void {
	if (!validator(value)) {
		throw new ProtocolError(formatSchemaError(validator.errors));
	}
}

function formatSchemaError(
	errors: readonly SchemaValidationError[] | null,
): string {
	const base64Error = errors?.find(
		(error) => schemaPattern(error) === neonLiveSchemaPatterns.base64Cell,
	);
	if (base64Error !== undefined) {
		return `${jsonPointerPath(base64Error.instancePath)} is not canonical base64`;
	}
	const cellShapeError = errors?.find(
		(error) =>
			error.keyword === "oneOf" &&
			/\/values\/[0-9]+$/u.test(error.instancePath),
	);
	if (cellShapeError !== undefined) {
		return `${jsonPointerPath(cellShapeError.instancePath)} is not a valid wire cell`;
	}

	const error = errors?.[0];
	if (error === undefined) return "does not match the protocol schema";

	const path = jsonPointerPath(error.instancePath);
	if (error.keyword === "discriminator") {
		const tag =
			typeof error.params.tag === "string" ? error.params.tag : "type";
		const tagValue = error.params.tagValue;
		return tagValue === undefined
			? `${path} is missing ${tag}`
			: `${path} has unknown ${tag} ${JSON.stringify(tagValue)}`;
	}
	if (error.keyword === "required") {
		return `${path} is missing ${String(error.params.missingProperty)}`;
	}
	if (error.keyword === "additionalProperties") {
		return `${path} has unexpected field ${String(error.params.additionalProperty)}`;
	}
	if (schemaPattern(error) === neonLiveSchemaPatterns.u64) {
		return `${path} is not a canonical positive uint64`;
	}
	if (schemaPattern(error) === neonLiveSchemaPatterns.rowKey) {
		return `${path} is not a lowercase 32-byte hex digest`;
	}
	if (schemaPattern(error) === neonLiveSchemaPatterns.heartbeatToken) {
		return `${path} is not a valid heartbeat token`;
	}
	if (path.endsWith("frontier.lsn")) {
		return `${path} is not canonical`;
	}
	if (error.keyword === "type") {
		return `${path} must be ${String(error.params.type)}`;
	}
	if (error.keyword === "enum" || error.keyword === "const") {
		return `${path} has an unknown value`;
	}
	if (error.keyword === "minimum" || error.keyword === "maximum") {
		return `${path} is outside its numeric bounds`;
	}
	if (error.keyword === "pattern") {
		return `${path} is outside its format or length bounds`;
	}
	return `${path} ${error.message ?? "does not match the protocol schema"}`;
}

function schemaPattern(error: SchemaValidationError): string | undefined {
	return typeof error.params.pattern === "string"
		? error.params.pattern
		: undefined;
}

function jsonPointerPath(pointer: string): string {
	if (pointer === "") return "message";
	const segments = pointer
		.slice(1)
		.split("/")
		.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
	return segments.reduce((path, segment) => {
		if (/^[0-9]+$/u.test(segment)) return `${path}[${segment}]`;
		return path === "" ? segment : `${path}.${segment}`;
	}, "");
}

function validateClientUtf8Limits(message: WireRecord): void {
	switch (wireString(message, "type")) {
		case "subscribe":
		case "renew":
			assertMaxUtf8Bytes(
				wireString(message, "authorization"),
				"authorization",
				262_144,
			);
			break;
		case "ping":
		case "pong":
			assertMaxUtf8Bytes(wireString(message, "token"), "token", 64);
			break;
	}
}

function validateServerUtf8Limits(message: WireRecord): void {
	switch (wireString(message, "type")) {
		case "open":
		case "keyed_results":
		case "reset_required":
		case "commit":
			assertMaxUtf8Bytes(
				wireString(message, "publication_id"),
				"publication_id",
				64,
			);
			break;
		case "ping":
		case "pong":
			assertMaxUtf8Bytes(wireString(message, "token"), "token", 64);
			break;
	}
}

function assertMaxUtf8Bytes(
	value: string,
	field: string,
	maximum: number,
): void {
	if (utf8ByteLength(value) > maximum) {
		throw new ProtocolError(`${field} exceeds its UTF-8 byte limit`);
	}
}

function wireString(value: WireRecord, field: string): string {
	return value[field] as string;
}

function utf8ByteLength(value: string): number {
	return UTF8.encode(value).byteLength;
}

// Scan the source representation iteratively so nested and escaped duplicate
// keys cannot disappear before JSON.parse and schema validation.
function rejectDuplicateKeys(text: string): void {
	const objects: Array<Set<string> | undefined> = [];
	for (let index = 0; index < text.length; index += 1) {
		const token = text[index];
		if (token === "{") {
			objects.push(new Set());
		} else if (token === "[") {
			objects.push(undefined);
		} else if (token === "}" || token === "]") {
			objects.pop();
		} else if (token === '"') {
			const start = index;
			index += 1;
			while (index < text.length && text[index] !== '"') {
				if (text[index] === "\\") index += 1;
				index += 1;
			}
			let after = index + 1;
			while (after < text.length && /\s/u.test(text.charAt(after)))
				after += 1;
			if (text[after] !== ":") continue;
			const keys = objects.at(-1);
			if (keys === undefined) {
				throw new ProtocolError("object key appears outside an object");
			}
			const key = JSON.parse(text.slice(start, index + 1)) as string;
			if (keys.has(key)) throw new ProtocolError("duplicate object key");
			keys.add(key);
		}
	}
}
