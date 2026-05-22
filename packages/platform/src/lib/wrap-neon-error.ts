import { ErrorCode, PlatformError } from "./errors.js";

/**
 * Context the wrapper attaches to every PlatformError so consumers can debug without
 * digging into the raw axios stack.
 */
export interface NeonErrorContext {
	/** Short label of the operation that failed, e.g. `getProject(proj-foo)` or `createBranch`. */
	op: string;
	/** Optional project id when the operation is project-scoped. */
	projectId?: string;
}

/**
 * Turn a raw error from `@neondatabase/api-client` (axios under the hood) into a typed
 * {@link PlatformError} whose message includes:
 *
 * 1. What operation was attempted (`op`, e.g. `getProject(proj-foo)`).
 * 2. Why it failed in human terms (e.g. "API key is unauthorized").
 * 3. The exact Neon API error message + request id (when present) for support tickets.
 * 4. A concrete next action ("Generate a new key at …", "Pass `projectId`", …).
 *
 * Non-axios errors are passed through unchanged (a regular `Error` already has a useful
 * stack trace; wrapping it would lose information without adding value).
 */
export function wrapNeonError(
	err: unknown,
	context: NeonErrorContext,
): PlatformError | unknown {
	if (err instanceof PlatformError) return err;
	const httpInfo = extractHttpInfo(err);
	if (!httpInfo) {
		const networkInfo = extractNetworkInfo(err);
		if (networkInfo) {
			return new PlatformError(
				ErrorCode.NetworkError,
				`Could not reach the Neon API while running ${context.op}: ${networkInfo.message}. Check your network connection and that https://console.neon.tech is reachable.`,
				{ cause: err, details: { op: context.op, ...networkInfo } },
			);
		}
		return err;
	}

	const apiSummary = httpInfo.neonMessage
		? `Neon API said: "${httpInfo.neonMessage}"`
		: `HTTP ${httpInfo.status}`;
	const requestIdSuffix = httpInfo.requestId
		? ` (request id ${httpInfo.requestId})`
		: "";

	switch (httpInfo.status) {
		case 401:
			return new PlatformError(
				ErrorCode.Unauthorized,
				[
					`${context.op} failed: API key is unauthorized.`,
					apiSummary + requestIdSuffix + ".",
					"Generate or rotate your key at https://console.neon.tech/app/settings/api-keys and set NEON_API_KEY (or pass --api-key).",
				].join(" "),
				{ cause: err, details: httpDetails(context, httpInfo) },
			);
		case 403:
			return new PlatformError(
				ErrorCode.Forbidden,
				[
					`${context.op} failed: this API key is not allowed to perform that operation.`,
					apiSummary + requestIdSuffix + ".",
					"Project-scoped keys can only operate on their own project; switch to an organisation/user-scoped key or pass `projectId` for an operation that doesn't need listing.",
				].join(" "),
				{ cause: err, details: httpDetails(context, httpInfo) },
			);
		case 404:
			return new PlatformError(
				ErrorCode.NotFound,
				[
					`${context.op} failed: resource not found on Neon.`,
					apiSummary + requestIdSuffix + ".",
					context.projectId
						? `Verify that project '${context.projectId}' exists in this account and that the API key has access to it.`
						: "Verify that the resource id is correct and that the API key has access to it.",
				].join(" "),
				{ cause: err, details: httpDetails(context, httpInfo) },
			);
		case 409:
			return new PlatformError(
				ErrorCode.Conflict,
				[
					`${context.op} failed: a conflicting resource already exists on Neon.`,
					apiSummary + requestIdSuffix + ".",
					"This is often a name collision (e.g. a branch with the same name already exists). Pull first to compare against the remote, or rename in your `neon.ts`.",
				].join(" "),
				{ cause: err, details: httpDetails(context, httpInfo) },
			);
		case 423:
			return new PlatformError(
				ErrorCode.Locked,
				[
					`${context.op} failed: the resource is still being modified by a previous operation, and our built-in retries did not drain it in time.`,
					apiSummary + requestIdSuffix + ".",
					"Wait a few seconds and re-run, or raise `retryOnLocked.maxAttempts` when constructing the real Neon adapter.",
				].join(" "),
				{ cause: err, details: httpDetails(context, httpInfo) },
			);
		case 429:
			return new PlatformError(
				ErrorCode.RateLimited,
				[
					`${context.op} failed: rate-limited by the Neon API.`,
					apiSummary + requestIdSuffix + ".",
					"Back off and retry; if this happens repeatedly, contact Neon support with the request id above.",
				].join(" "),
				{ cause: err, details: httpDetails(context, httpInfo) },
			);
	}

	if (httpInfo.status >= 500) {
		return new PlatformError(
			ErrorCode.ServerError,
			[
				`${context.op} failed: the Neon API returned a server error (HTTP ${httpInfo.status}).`,
				apiSummary + requestIdSuffix + ".",
				"This is most likely transient. Retry shortly; if it persists, file an issue with the request id above and check https://neonstatus.com.",
			].join(" "),
			{ cause: err, details: httpDetails(context, httpInfo) },
		);
	}

	// 4xx we don't have a dedicated code for. Surface what we know.
	return new PlatformError(
		ErrorCode.ServerError,
		`${context.op} failed: HTTP ${httpInfo.status}. ${apiSummary}${requestIdSuffix}.`,
		{ cause: err, details: httpDetails(context, httpInfo) },
	);
}

interface HttpInfo {
	status: number;
	neonMessage?: string;
	neonCode?: string;
	requestId?: string;
}

function extractHttpInfo(err: unknown): HttpInfo | null {
	if (err === null || typeof err !== "object") return null;
	const response = (err as { response?: unknown }).response;
	if (response === null || typeof response !== "object") return null;
	const status = (response as { status?: unknown }).status;
	if (typeof status !== "number") return null;
	const data = (response as { data?: unknown }).data;
	const out: HttpInfo = { status };
	if (data !== null && typeof data === "object") {
		const dataObj = data as Record<string, unknown>;
		if (typeof dataObj.message === "string" && dataObj.message !== "")
			out.neonMessage = dataObj.message;
		if (typeof dataObj.code === "string" && dataObj.code !== "")
			out.neonCode = dataObj.code;
		if (typeof dataObj.request_id === "string" && dataObj.request_id !== "")
			out.requestId = dataObj.request_id;
	}
	return out;
}

interface NetworkInfo {
	message: string;
	code?: string;
}

function extractNetworkInfo(err: unknown): NetworkInfo | null {
	if (err === null || typeof err !== "object") return null;
	const code = (err as { code?: unknown }).code;
	const message = (err as { message?: unknown }).message;
	if (
		typeof code === "string" &&
		/^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)$/.test(
			code,
		)
	) {
		return { message: typeof message === "string" ? message : code, code };
	}
	// axios timeout reports `code: "ECONNABORTED"`.
	if (code === "ECONNABORTED") {
		return {
			message: typeof message === "string" ? message : "timeout",
			code,
		};
	}
	return null;
}

function httpDetails(
	context: NeonErrorContext,
	info: HttpInfo,
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		op: context.op,
		status: info.status,
	};
	if (context.projectId) out.projectId = context.projectId;
	if (info.neonMessage) out.neonMessage = info.neonMessage;
	if (info.neonCode) out.neonCode = info.neonCode;
	if (info.requestId) out.requestId = info.requestId;
	return out;
}
