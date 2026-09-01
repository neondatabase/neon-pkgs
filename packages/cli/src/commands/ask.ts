import type yargs from "yargs";

import { isCi } from "../env.js";
import { isNetworkError } from "../errors.js";
import type { CommonProps } from "../types.js";
import { noPassthrough, single } from "../utils/flags.js";
import { writer } from "../writer.js";
import { isEventStreamContentType, readAskSse } from "./ask_sse.js";
import { createThinkingSpinner } from "./thinking_spinner.js";

export const DEFAULT_ASK_URL =
	"https://br-frosty-cell-a5smzg39-assistant.compute.c-1.us-east-2.aws.neon.tech/ask";

const ASK_TIMEOUT_MS = 120_000;

type AskProps = CommonProps & {
	prompt: string;
	url?: string;
};

export const command = "ask";
export const describe = "Ask a question about Neon";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 ask --prompt <question>")
		.option("prompt", {
			describe: "The question to ask",
			type: "string",
			demandOption: true,
			coerce: single("prompt", { required: true }),
		})
		.option("url", {
			describe: "Override the assistant URL",
			type: "string",
			hidden: true,
			coerce: single("url"),
		})
		.strict()
		.check(noPassthrough("ask"))
		.example(
			'$0 ask --prompt "How do schema-only branches work?"',
			describe,
		);

export function resolveAskUrl(opts: { url?: string; envUrl?: string }): string {
	const fromFlag = opts.url?.trim();
	if (fromFlag) return fromFlag;
	const fromEnv = opts.envUrl?.trim();
	if (fromEnv) return fromEnv;
	return DEFAULT_ASK_URL;
}

function isMachineOutput(output: AskProps["output"]): boolean {
	return output === "json" || output === "yaml";
}

export const handler = async (props: AskProps) => {
	const url = resolveAskUrl({
		url: props.url,
		envUrl: process.env.NEON_ASK_URL,
	});
	const human = !isMachineOutput(props.output);
	const spinner = createThinkingSpinner({
		out: process.stderr,
		isTty: Boolean(process.stderr.isTTY) && !isCi() && human,
	});
	let streamed = "";
	try {
		spinner.start();
		const text = await askAssistant({
			prompt: props.prompt,
			url,
			acceptEventStream: human,
			onStatus: (message) => {
				spinner.setMessage(message);
			},
			onText: (chunk) => {
				if (!human) {
					return;
				}
				spinner.stop();
				streamed += chunk;
				writer(props).text(chunk);
			},
		});
		spinner.stop();
		if (!human) {
			writer(props).end({ text }, { fields: ["text"] });
			return;
		}
		if (streamed === "") {
			writer(props).text(`${text}\n`);
			return;
		}
		if (!streamed.endsWith("\n")) {
			writer(props).text("\n");
		}
	} catch (error) {
		spinner.stop();
		if (human && streamed !== "" && !streamed.endsWith("\n")) {
			writer(props).text("\n");
		}
		throw error;
	} finally {
		spinner.stop();
	}
};

function isAskTimeout(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "TimeoutError" || error.name === "AbortError")
	);
}

function askErrorMessage(body: unknown, status: number): string {
	if (
		typeof body === "object" &&
		body !== null &&
		"error" in body &&
		typeof body.error === "string" &&
		body.error.trim() !== ""
	) {
		return body.error;
	}
	return `The Neon assistant returned ${status}.`;
}

function askText(body: unknown): string {
	if (
		typeof body === "object" &&
		body !== null &&
		"text" in body &&
		typeof body.text === "string"
	) {
		return body.text;
	}
	throw new Error("The Neon assistant returned an unexpected response.");
}

async function readJsonBody(response: Response): Promise<unknown> {
	const raw = await response.text();
	if (raw.trim() === "") {
		return undefined;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

async function readStreamedAsk(
	body: ReadableStream<Uint8Array>,
	opts: {
		onStatus?: (message: string) => void;
		onText?: (text: string) => void;
	},
): Promise<string> {
	let text = "";
	let sawDone = false;
	for await (const event of readAskSse(body)) {
		switch (event.type) {
			case "status":
				opts.onStatus?.(event.message);
				break;
			case "text":
				text += event.text;
				opts.onText?.(event.text);
				break;
			case "error":
				throw new Error(event.error);
			case "done":
				sawDone = true;
				break;
		}
	}
	if (!sawDone) {
		throw new Error("The Neon assistant returned an unexpected response.");
	}
	return text;
}

async function askAssistant(opts: {
	prompt: string;
	url: string;
	acceptEventStream: boolean;
	onStatus?: (message: string) => void;
	onText?: (text: string) => void;
}): Promise<string> {
	let response: Response;
	try {
		response = await fetch(opts.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: opts.acceptEventStream
					? "text/event-stream"
					: "application/json",
				"x-neon-source": "cli",
			},
			body: JSON.stringify({ prompt: opts.prompt }),
			signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
		});
	} catch (error) {
		if (isAskTimeout(error)) {
			throw new Error("The Neon assistant did not respond in time.");
		}
		if (isNetworkError(error)) {
			throw new Error(
				"Could not reach the Neon assistant. Check your internet connection and try again.",
			);
		}
		throw error;
	}

	if (!response.ok) {
		const body = await readJsonBody(response);
		throw new Error(askErrorMessage(body, response.status));
	}

	if (
		opts.acceptEventStream &&
		isEventStreamContentType(
			response.headers.get("content-type") ?? undefined,
		)
	) {
		if (!response.body) {
			throw new Error(
				"The Neon assistant returned an unexpected response.",
			);
		}
		return readStreamedAsk(response.body, opts);
	}

	const body = await readJsonBody(response);
	return askText(body);
}
