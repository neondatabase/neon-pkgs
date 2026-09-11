// The Functions proxy drops client-supplied x-neon-* headers, so a present
// value is from a trigger delivery. It must match body.invocation_id.
const TRIGGER_INVOCATION_ID_HEADER = "x-neon-trigger-invocation-id";

export type ScheduleTriggerInvocation = {
	version: 1;
	invocationId: string;
	trigger: {
		type: "schedule";
		id: string;
		name: string;
	};
	data: {
		scheduledAt: string;
	};
};

export type TriggerInvocation = ScheduleTriggerInvocation;

export type ParseTriggerInvocationInput = {
	headers: HeadersInit;
	data: unknown;
};

export type ParseTriggerInvocationResult =
	| { ok: true; invocation: TriggerInvocation }
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
		trigger: { type: "schedule", id: triggerId, name: triggerName },
		data: { scheduledAt },
	};
}

function parseFromHeadersAndData(
	headers: HeadersInit,
	data: unknown,
): ParseTriggerInvocationResult {
	const headerId = new Headers(headers)
		.get(TRIGGER_INVOCATION_ID_HEADER)
		?.trim();
	if (!headerId) {
		return { ok: false, error: "missing_header" };
	}

	const invocation = parseScheduleInvocation(data);
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
): Promise<ParseTriggerInvocationResult> {
	let data: unknown;
	try {
		// Clone so the caller can still request.json() after this returns.
		data = await request.clone().json();
	} catch {
		return { ok: false, error: "invalid_body" };
	}
	return parseFromHeadersAndData(request.headers, data);
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
		return parseFromRequest(input);
	}
	return parseFromHeadersAndData(input.headers, input.data);
}
