export type AskStreamEvent =
	| { type: "status"; message: string }
	| { type: "text"; text: string }
	| { type: "error"; error: string }
	| { type: "done" };

export function isEventStreamContentType(header: string | undefined): boolean {
	const media = header?.split(";")[0]?.trim().toLowerCase();
	return media === "text/event-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseSseBlock(
	block: string,
): { event: string; data: string } | undefined {
	let event = "message";
	const dataLines: string[] = [];
	for (const line of block.split(/\r?\n/)) {
		if (line === "" || line.startsWith(":")) {
			continue;
		}
		if (line.startsWith("event:")) {
			event = line.slice("event:".length).trim();
			continue;
		}
		if (line.startsWith("data:")) {
			dataLines.push(line.slice("data:".length).replace(/^ /, ""));
		}
	}
	if (event === "ping") {
		return undefined;
	}
	if (event === "message" && dataLines.length === 0) {
		return undefined;
	}
	return { event, data: dataLines.join("\n") };
}

function takeSseBlocks(pending: string): {
	events: Array<{ event: string; data: string }>;
	rest: string;
} {
	const events: Array<{ event: string; data: string }> = [];
	let rest = pending;
	while (true) {
		const lf = rest.indexOf("\n\n");
		const crlf = rest.indexOf("\r\n\r\n");
		let at = -1;
		let sep = 0;
		if (lf === -1 && crlf === -1) {
			break;
		}
		if (crlf !== -1 && (lf === -1 || crlf < lf)) {
			at = crlf;
			sep = 4;
		} else {
			at = lf;
			sep = 2;
		}
		const parsed = parseSseBlock(rest.slice(0, at));
		rest = rest.slice(at + sep);
		if (parsed) {
			events.push(parsed);
		}
	}
	return { events, rest };
}

function mapAskEvent(raw: {
	event: string;
	data: string;
}): AskStreamEvent | undefined {
	if (raw.event === "done") {
		return { type: "done" };
	}
	let parsed: unknown;
	try {
		parsed = raw.data === "" ? undefined : JSON.parse(raw.data);
	} catch {
		return undefined;
	}
	if (raw.event === "status") {
		if (
			!isRecord(parsed) ||
			typeof parsed.message !== "string" ||
			parsed.message === ""
		) {
			return undefined;
		}
		return { type: "status", message: parsed.message };
	}
	if (raw.event === "text") {
		if (
			!isRecord(parsed) ||
			typeof parsed.text !== "string" ||
			parsed.text === ""
		) {
			return undefined;
		}
		return { type: "text", text: parsed.text };
	}
	if (raw.event === "error") {
		const error =
			isRecord(parsed) &&
			typeof parsed.error === "string" &&
			parsed.error.trim() !== ""
				? parsed.error
				: "The assistant failed.";
		return { type: "error", error };
	}
	return undefined;
}

export async function* readAskSse(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<AskStreamEvent> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let pending = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			pending += decoder.decode(value ?? new Uint8Array(), {
				stream: !done,
			});
			const taken = takeSseBlocks(pending);
			pending = taken.rest;
			for (const raw of taken.events) {
				const event = mapAskEvent(raw);
				if (!event) {
					continue;
				}
				yield event;
				if (event.type === "error" || event.type === "done") {
					return;
				}
			}
			if (done) {
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
}
