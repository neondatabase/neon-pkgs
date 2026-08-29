import type yargs from "yargs";

import { isNetworkError } from "../errors.js";
import type { CommonProps } from "../types.js";
import { noPassthrough, single } from "../utils/flags.js";
import { writer } from "../writer.js";

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

export const handler = async (props: AskProps) => {
	const url = resolveAskUrl({
		url: props.url,
		envUrl: process.env.NEON_ASK_URL,
	});
	const text = await askAssistant({ prompt: props.prompt, url });
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end({ text }, { fields: ["text"] });
		return;
	}
	writer(props).text(`${text}\n`);
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

async function askAssistant(opts: {
	prompt: string;
	url: string;
}): Promise<string> {
	let response: Response;
	try {
		response = await fetch(opts.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
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

	const body = await readJsonBody(response);
	if (!response.ok) {
		throw new Error(askErrorMessage(body, response.status));
	}
	return askText(body);
}
