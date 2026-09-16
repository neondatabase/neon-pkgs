// The Functions proxy drops client-supplied x-neon-* headers, so a present
// value is from a trigger delivery. It must match body.invocation_id.
const TRIGGER_INVOCATION_ID_HEADER = "x-neon-trigger-invocation-id";

export type ScheduleTriggerInvocation = {
	version: 1;
	invocationId: string;
	type?: "schedule";
	trigger: {
		type: "schedule";
		id: string;
		name: string;
	};
	data: {
		scheduledAt: string;
	};
};

export type StorageObjectCreatedTriggerInvocation = {
	version: 1;
	invocationId: string;
	type: "storage_object_created";
	trigger: {
		type: "storage_object_created";
		id: string;
		name: string;
	};
	data: {
		bucketName: string;
		objectKey: string;
	};
};

export type TriggerInvocation =
	| ScheduleTriggerInvocation
	| StorageObjectCreatedTriggerInvocation;

export function isScheduleTriggerInvocation(
	invocation: TriggerInvocation,
): invocation is ScheduleTriggerInvocation {
	return invocation.trigger.type === "schedule";
}

export function isStorageObjectCreatedTriggerInvocation(
	invocation: TriggerInvocation,
): invocation is StorageObjectCreatedTriggerInvocation {
	return invocation.type === "storage_object_created";
}

export type ParseTriggerInvocationInput = {
	headers: HeadersInit;
	body: unknown;
};

export type ParseTriggerDeliveryResult =
	| { ok: true; invocation: TriggerInvocation }
	| {
			ok: false;
			error: "missing_header" | "invalid_body" | "invocation_id_mismatch";
	  };

export type ParseTriggerInvocationResult =
	| { ok: true; invocation: ScheduleTriggerInvocation }
	| {
			ok: false;
			error: "missing_header" | "invalid_body" | "invocation_id_mismatch";
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequest(
	input: Request | ParseTriggerInvocationInput,
): input is Request {
	return input instanceof Request;
}

function parseScheduleInvocation(
	body: unknown,
): ScheduleTriggerInvocation | undefined {
	if (!isRecord(body) || body.version !== 1) return undefined;

	const invocationId = body.invocation_id;
	if (typeof invocationId !== "string" || invocationId === "")
		return undefined;

	if (!isRecord(body.trigger) || body.trigger.type !== "schedule") {
		return undefined;
	}
	const triggerId = body.trigger.id;
	const triggerName = body.trigger.name;
	if (typeof triggerId !== "string" || triggerId === "") return undefined;
	if (typeof triggerName !== "string" || triggerName === "") return undefined;

	if (!isRecord(body.data)) return undefined;
	const scheduledAt = body.data.scheduled_at;
	if (typeof scheduledAt !== "string" || scheduledAt === "") return undefined;

	return {
		version: 1,
		invocationId,
		type: "schedule",
		trigger: { type: "schedule", id: triggerId, name: triggerName },
		data: { scheduledAt },
	};
}

function parseStorageObjectCreatedInvocation(
	body: unknown,
): StorageObjectCreatedTriggerInvocation | undefined {
	if (!isRecord(body) || body.version !== 1) return undefined;

	const invocationId = body.invocation_id;
	if (typeof invocationId !== "string" || invocationId === "")
		return undefined;

	if (
		!isRecord(body.trigger) ||
		body.trigger.type !== "storage_object_created"
	) {
		return undefined;
	}
	const triggerId = body.trigger.id;
	const triggerName = body.trigger.name;
	if (typeof triggerId !== "string" || triggerId === "") return undefined;
	if (typeof triggerName !== "string" || triggerName === "") return undefined;

	if (!isRecord(body.data)) return undefined;
	const bucketName = body.data.bucket_name;
	const objectKey = body.data.object_key;
	if (typeof bucketName !== "string" || bucketName === "") return undefined;
	if (typeof objectKey !== "string" || objectKey === "") return undefined;

	return {
		version: 1,
		invocationId,
		type: "storage_object_created",
		trigger: {
			type: "storage_object_created",
			id: triggerId,
			name: triggerName,
		},
		data: { bucketName, objectKey },
	};
}

function parseInvocation(body: unknown): TriggerInvocation | undefined {
	return (
		parseScheduleInvocation(body) ??
		parseStorageObjectCreatedInvocation(body)
	);
}

function parseFromHeadersAndData(
	headers: HeadersInit,
	body: unknown,
): ParseTriggerDeliveryResult {
	const headerId = new Headers(headers)
		.get(TRIGGER_INVOCATION_ID_HEADER)
		?.trim();
	if (!headerId) {
		return { ok: false, error: "missing_header" };
	}

	const invocation = parseInvocation(body);
	if (!invocation) {
		return { ok: false, error: "invalid_body" };
	}
	if (invocation.invocationId !== headerId) {
		return { ok: false, error: "invocation_id_mismatch" };
	}

	return { ok: true, invocation };
}

async function parseFromRequest(
	request: Request,
): Promise<ParseTriggerDeliveryResult> {
	const headerId = request.headers.get(TRIGGER_INVOCATION_ID_HEADER)?.trim();
	if (!headerId) {
		return { ok: false, error: "missing_header" };
	}

	let body: unknown;
	try {
		// Clone so the caller can still request.json() after this returns.
		body = await request.clone().json();
	} catch {
		return { ok: false, error: "invalid_body" };
	}
	return parseFromHeadersAndData(request.headers, body);
}

function asScheduleResult(
	result: ParseTriggerDeliveryResult,
): ParseTriggerInvocationResult {
	if (!result.ok) return result;
	if (!isScheduleTriggerInvocation(result.invocation)) {
		return { ok: false, error: "invalid_body" };
	}
	return { ok: true, invocation: result.invocation };
}

export function parseTriggerDelivery(
	request: Request,
): Promise<ParseTriggerDeliveryResult>;
export function parseTriggerDelivery(
	input: ParseTriggerInvocationInput,
): ParseTriggerDeliveryResult;
export function parseTriggerDelivery(
	input: Request | ParseTriggerInvocationInput,
): ParseTriggerDeliveryResult | Promise<ParseTriggerDeliveryResult> {
	if (isRequest(input)) {
		return parseFromRequest(input);
	}
	return parseFromHeadersAndData(input.headers, input.body);
}

export function parseTriggerInvocation(
	request: Request,
): Promise<ParseTriggerInvocationResult>;
export function parseTriggerInvocation(
	input: ParseTriggerInvocationInput,
): ParseTriggerInvocationResult;
export function parseTriggerInvocation(
	input: Request | ParseTriggerInvocationInput,
): ParseTriggerInvocationResult | Promise<ParseTriggerInvocationResult> {
	if (isRequest(input)) {
		return parseFromRequest(input).then(asScheduleResult);
	}
	return asScheduleResult(parseFromHeadersAndData(input.headers, input.body));
}
