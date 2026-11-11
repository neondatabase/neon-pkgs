import { type ParsedMvccSnapshot, parseMvccSnapshot } from "../mvcc.js";
import {
	type ClientMessage,
	REALTIME_SUBPROTOCOL_V2,
	type RealtimeSubprotocol,
	type ServerMessage,
} from "./messages.js";
import {
	validateClientMessage as generatedClientMessageValidator,
	validateServerMessage as generatedServerMessageValidator,
	realtimeSchemaPatterns,
} from "./schema-validator.gen.js";

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
		super(`Invalid Realtime protocol message: ${message}`);
		this.name = "ProtocolError";
	}
}

export interface DecodedServerFrame {
	readonly message: ServerMessage;
	/** Parsed once so connection-wide progress can share immutable evidence. */
	readonly mvcc?: ParsedMvccSnapshot;
}

/** Serialize one validated client command to a WebSocket text frame. */
export function encodeClientMessage(message: ClientMessage): string {
	assertSchema(validateClientMessage, message);
	validateClientUtf8Limits(message as WireRecord);
	return JSON.stringify(message);
}

/** Parse and strictly validate one server WebSocket text frame. */
export function decodeServerMessage(
	text: string,
	subprotocol: RealtimeSubprotocol,
): ServerMessage {
	return decodeServerFrame(text, subprotocol).message;
}

/**
 * Decode a server frame of the negotiated subprotocol and parse any
 * connection-wide progress evidence. A v2 frame is returned in the v3 shape.
 */
export function decodeServerFrame(
	text: string,
	subprotocol: RealtimeSubprotocol,
): DecodedServerFrame {
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

	const v2 = subprotocol === REALTIME_SUBPROTOCOL_V2;
	if (v2) value = liftV2Frame(value);
	assertSchema(validateServerMessage, value);
	const message = value as ServerMessage;
	if (v2) rejectSegmentTags(message);
	validateServerUtf8Limits(message as WireRecord);
	let mvcc: ParsedMvccSnapshot | undefined;
	if (message.type === "baseline_sync_start" || message.type === "progress") {
		try {
			mvcc = parseMvccSnapshot(message.mvcc);
		} catch (error) {
			throw new ProtocolError(
				error instanceof Error ? error.message : "invalid MVCC proof",
			);
		}
	}
	return Object.freeze({
		message: freezeWireValue(message),
		mvcc,
	});
}

/**
 * Every v2 baseline sync is the one round that starts its epoch, so it names
 * one round per epoch. Any valid round ID would do; this is the smallest.
 */
const V2_ROUND = "1";

/**
 * Express a v2 frame in the v3 shape before v3 validation.
 *
 * Protocol v3 is v2 plus `segments_pending`, a round and scope on baseline
 * syncs, and optional segment tags on rows. A v2 frame carries none of
 * them, and a v2 baseline sync is a round with scope `all` and no covered
 * range. Rejecting the v3 additions here and in {@link rejectSegmentTags},
 * then adding that round and scope, makes v3 validation accept exactly the
 * frames the v2 schema accepts.
 */
function liftV2Frame(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return value;
	const frame = value as WireRecord;
	switch (frame.type) {
		case "segments_pending":
			throw new ProtocolError("segments_pending requires protocol v3");
		case "baseline_sync_start":
		case "baseline_sync_batch":
		case "baseline_sync_end": {
			for (const field of ["round", "scope", "covered"]) {
				if (Object.hasOwn(frame, field)) {
					throw new ProtocolError(
						`message has unexpected field ${field}`,
					);
				}
			}
			return frame.type === "baseline_sync_start"
				? { ...frame, round: V2_ROUND, scope: { kind: "all" } }
				: { ...frame, round: V2_ROUND };
		}
		default:
			return frame;
	}
}

/** Reject the v3 segment tag on a validated v2 row or upsert. */
function rejectSegmentTags(message: ServerMessage): void {
	const tagged =
		message.type === "baseline_sync_batch"
			? message.rows.findIndex((row) => row.segment_tag !== undefined)
			: message.type === "keyed_results"
				? message.changes.findIndex(
						(change) =>
							change.op === "upsert" &&
							change.segment_tag !== undefined,
					)
				: -1;
	if (tagged === -1) return;
	const field = message.type === "baseline_sync_batch" ? "rows" : "changes";
	throw new ProtocolError(
		`${field}[${tagged}] has unexpected field segment_tag`,
	);
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
		(error) => schemaPattern(error) === realtimeSchemaPatterns.base64Cell,
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
	if (schemaPattern(error) === realtimeSchemaPatterns.u64) {
		return `${path} is not a canonical positive uint64`;
	}
	if (schemaPattern(error) === realtimeSchemaPatterns.rowKey) {
		return `${path} is not a lowercase 32-byte hex digest`;
	}
	if (schemaPattern(error) === realtimeSchemaPatterns.heartbeatToken) {
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
		case "segments_pending":
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
