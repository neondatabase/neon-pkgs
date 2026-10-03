import type yargs from "yargs";

import { isNetworkError } from "../errors.js";
import type { CommonProps } from "../types.js";
import { noPassthrough, single } from "../utils/flags.js";
import { writer } from "../writer.js";

export const DEFAULT_FEEDBACK_URL = "https://feedback.neon.tech/";

/** The feedback service truncates longer messages, so the CLI rejects them instead. */
export const MAX_FEEDBACK_LENGTH = 10_000;

const FEEDBACK_SOURCE = "neon_cli";
const FEEDBACK_TIMEOUT_MS = 30_000;

type FeedbackProps = CommonProps & {
	message: string;
	url?: string;
};

export const command = "feedback";
export const describe = "Send feedback to Neon";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 feedback --message <feedback>")
		.option("message", {
			describe:
				"The feedback to send. Do not include passwords, API keys, or connection strings",
			type: "string",
			demandOption: true,
			coerce: single("message", { required: true }),
		})
		.option("url", {
			describe: "Override the feedback URL",
			type: "string",
			hidden: true,
			coerce: single("url"),
		})
		.strict()
		.check(noPassthrough("feedback"))
		.check((args) => {
			const message =
				typeof args.message === "string" ? args.message : "";
			if (message.trim().length > MAX_FEEDBACK_LENGTH) {
				throw new Error(
					`--message must be ${MAX_FEEDBACK_LENGTH.toLocaleString("en-US")} characters or fewer`,
				);
			}
			return true;
		})
		.example(
			'$0 feedback --message "The branch docs were unclear"',
			describe,
		);

export function resolveFeedbackUrl(opts: {
	url?: string;
	envUrl?: string;
}): string {
	const fromFlag = opts.url?.trim();
	if (fromFlag) return fromFlag;
	const fromEnv = opts.envUrl?.trim();
	if (fromEnv) return fromEnv;
	return DEFAULT_FEEDBACK_URL;
}

export const handler = async (props: FeedbackProps) => {
	await sendFeedback({
		message: props.message.trim(),
		url: resolveFeedbackUrl({
			url: props.url,
			envUrl: process.env.NEON_FEEDBACK_URL,
		}),
	});
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end({ received: true }, { fields: ["received"] });
		return;
	}
	writer(props).text("Feedback received. Thank you!\n");
};

function isTimeout(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "TimeoutError" || error.name === "AbortError")
	);
}

async function feedbackErrorMessage(response: Response): Promise<string> {
	if (response.status === 429) {
		return "Too many feedback requests. Wait a minute and try again.";
	}
	try {
		const body: unknown = await response.json();
		if (
			typeof body === "object" &&
			body !== null &&
			"error" in body &&
			typeof body.error === "string" &&
			body.error.trim() !== ""
		) {
			return body.error;
		}
	} catch {
		// Fall through to the status-only message.
	}
	return `The Neon feedback service returned ${response.status}.`;
}

async function sendFeedback(opts: {
	message: string;
	url: string;
}): Promise<void> {
	let response: Response;
	try {
		response = await fetch(opts.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				feedback: opts.message,
				source: FEEDBACK_SOURCE,
			}),
			signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
		});
	} catch (error) {
		if (isTimeout(error)) {
			throw new Error(
				"The Neon feedback service did not respond in time.",
			);
		}
		if (isNetworkError(error)) {
			throw new Error(
				"Could not reach the Neon feedback service. Check your internet connection and try again.",
			);
		}
		throw error;
	}
	if (!response.ok) {
		throw new Error(await feedbackErrorMessage(response));
	}
}
