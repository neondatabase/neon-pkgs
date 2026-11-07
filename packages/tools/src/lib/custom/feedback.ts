import * as z from "zod";
import {
	bindPublicTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";
import { upstreamSignal } from "./docs.js";

export const DEFAULT_FEEDBACK_URL = "https://feedback.neon.tech/";
export const DEFAULT_FEEDBACK_SOURCE = "neon_tools";

// The feedback service truncates longer messages, so reject them instead.
export const MAX_FEEDBACK_LENGTH = 10_000;

export const sendFeedbackInputSchema = z.strictObject({
	feedback: z
		.string()
		.trim()
		.min(1)
		.max(MAX_FEEDBACK_LENGTH)
		.describe(
			"The feedback to send to Neon. Do not include passwords, API keys, connection strings, or other secrets.",
		),
});

/** Sends only the message and `source` to the Neon feedback service: no account, project, or credential. */
export const sendFeedbackTool = (options: ToolClientOptions) => {
	const url = options.feedbackUrl ?? DEFAULT_FEEDBACK_URL;
	const source = options.feedbackSource ?? DEFAULT_FEEDBACK_SOURCE;
	const fetchImpl = options.fetch ?? fetch;
	return bindPublicTool(
		{
			operationId: "feedback.send",
			id: publishedId("feedback.send"),
			title: "Send Feedback",
			description:
				"Send anonymous feedback about Neon or this tool to the Neon team. Only call this when the user asks to give feedback. Sends only the feedback text, not account, project, or connection details.",
			inputSchema: sendFeedbackInputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			requiresApproval: true,
			metadata: {
				method: "POST",
				path: "/",
				stability: "stable",
				deprecated: false,
				tags: ["Feedback"],
			},
		},
		async ({ feedback }, context) => {
			let response: Response;
			try {
				response = await fetchImpl(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ feedback, source }),
					signal: upstreamSignal(context.signal),
				});
			} catch (error) {
				// Without this, the caller sees only "TypeError: fetch failed".
				const reason =
					error instanceof Error && error.name === "TimeoutError"
						? "did not respond in time"
						: "could not be reached";
				throw new Error(
					`The Neon feedback service ${reason}. Try again later.`,
					{ cause: error },
				);
			}
			if (response.status === 429) {
				throw new Error(
					"Too many feedback requests. Wait a minute and try again.",
				);
			}
			if (!response.ok) {
				throw new Error(
					`Failed to send feedback: ${response.status} ${response.statusText}`,
				);
			}
			return { message: "Feedback received. Thank you!" };
		},
	);
};
