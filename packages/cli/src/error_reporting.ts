import type {
	BaseTransportOptions,
	ErrorEvent,
	StackFrame,
	Transport,
} from "@sentry/core";
import { createStackParser, createTransport, Scope } from "@sentry/core";
import { nodeStackLineParser, ServerRuntimeClient } from "@sentry/core/server";
import { getCliAgent, isCi } from "./env.js";
import pkg from "./pkg.js";

let dsn =
	"https://d2af98d872a47127826e36635023fcac@o1373725.ingest.us.sentry.io/4512222983290880";

/** Lets tests send to a local collector; the CLI itself always reports to sentry.io. */
export const useErrorReportingDsnForTests = (testDsn: string) => {
	dsn = testDsn;
};

const FLUSH_TIMEOUT_MS = 2000;

const fetchTransport = (options: BaseTransportOptions): Transport =>
	createTransport(options, async (request) => {
		const response = await fetch(options.url, {
			method: "POST",
			body:
				typeof request.body === "string"
					? request.body
					: new Uint8Array(request.body),
		});
		return {
			statusCode: response.status,
			headers: {
				"x-sentry-rate-limits": response.headers.get(
					"x-sentry-rate-limits",
				),
				"retry-after": response.headers.get("retry-after"),
			},
		};
	});

/**
 * Stack frames carry absolute paths, which include the user's home directory. Keep the part
 * from the package onward (`neon/dist/index.js`); anything outside `node_modules` keeps only
 * its file name.
 */
export const packageRelativePath = (path: string): string => {
	const normalized = path.replace(/\\/g, "/").replace(/^file:\/\//, "");
	if (normalized.startsWith("node:")) {
		return normalized;
	}
	const at = normalized.lastIndexOf("/node_modules/");
	if (at >= 0) {
		return normalized.slice(at + "/node_modules/".length);
	}
	if (!normalized.includes("/")) {
		return normalized;
	}
	return normalized.slice(normalized.lastIndexOf("/") + 1);
};

// An installed CLI runs from `node_modules/neon`, which Sentry would otherwise treat as library
// code and leave out of issue grouping.
const scrubFrame = (frame: StackFrame): StackFrame => {
	if (frame.filename === undefined) {
		return frame;
	}
	const filename = packageRelativePath(frame.filename);
	return {
		...frame,
		filename,
		...(frame.abs_path !== undefined
			? { abs_path: packageRelativePath(frame.abs_path) }
			: {}),
		...(filename.startsWith("neon/") ? { in_app: true } : {}),
	};
};

/**
 * V8 messages whose only variable part is an identifier from the code. Any other message can
 * quote user input (`JSON.parse` echoes what it failed on, Node's argument errors print the
 * received value), so it is replaced rather than sent.
 */
const SAFE_MESSAGES = [
	/^Cannot read properties of (undefined|null) \(reading '[\w$]+'\)$/,
	/^Cannot set properties of (undefined|null) \(setting '[\w$]+'\)$/,
	/^[\w$.()]+ is not a function$/,
	/^[\w$.()]+ is not iterable$/,
	/^[\w$]+ is not defined$/,
	/^Cannot access '[\w$]+' before initialization$/,
	/^Assignment to constant variable\.$/,
	/^Invalid time value$/,
	/^Maximum call stack size exceeded$/,
];

const OMITTED_MESSAGE = "(message omitted)";

const safeMessage = (message: string): string =>
	SAFE_MESSAGES.some((pattern) => pattern.test(message))
		? message
		: OMITTED_MESSAGE;

// V8 starts `stack` with the full message, newlines included, and Sentry parses every line after
// the first as a frame. Only indented `at` lines are frames.
const stackFrameLines = (error: Error): string[] => {
	const stack = error.stack ?? "";
	const header = error.message
		? `${error.name}: ${error.message}`
		: error.name;
	const frames = stack.startsWith(header)
		? stack.slice(header.length)
		: stack;
	return frames.split("\n").filter((line) => /^ {4}at /.test(line));
};

const sanitizeError = (
	error: Error,
	redact: (text: string) => string,
): Error => {
	const message = redact(safeMessage(error.message));
	const sanitized = new Error(message);
	sanitized.name = error.name;
	sanitized.stack = [
		`${error.name}: ${message}`,
		...stackFrameLines(error),
	].join("\n");
	return sanitized;
};

const scrubEvent = (event: ErrorEvent): ErrorEvent => {
	const { server_name: _serverName, ...rest } = event;
	return {
		...rest,
		...(event.exception?.values
			? {
					exception: {
						values: event.exception.values.map((exception) => ({
							...exception,
							...(exception.stacktrace?.frames
								? {
										stacktrace: {
											...exception.stacktrace,
											frames: exception.stacktrace.frames.map(
												scrubFrame,
											),
										},
									}
								: {}),
						})),
					},
				}
			: {}),
	};
};

export const reportUnexpectedError = async (
	error: Error,
	redact: (text: string) => string,
): Promise<void> => {
	const client = new ServerRuntimeClient({
		dsn,
		release: `neon@${pkg.version}`,
		environment: "production",
		platform: "node",
		runtime: { name: "node", version: process.version },
		stackParser: createStackParser(nodeStackLineParser()),
		integrations: [],
		transport: fetchTransport,
		beforeSend: scrubEvent,
	});
	client.init();
	const scope = new Scope();
	scope.setClient(client);
	scope.setTags({
		ci: String(isCi()),
		agent: getCliAgent(process.env) ?? "none",
	});
	client.captureException(sanitizeError(error, redact), undefined, scope);
	await client.flush(FLUSH_TIMEOUT_MS);
};
