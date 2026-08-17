// node-postgres treats an idle-client pool error with no listener as fatal.
// The pool has already discarded the client; the next checkout replaces it.

const PG_ADMIN_SHUTDOWN = "57P01";
const IDLE_DISCONNECT_CODES = new Set([
	"ECONNRESET",
	"EPIPE",
	"ETIMEDOUT",
	PG_ADMIN_SHUTDOWN,
]);

const attached = new WeakSet<object>();

const UNEXPECTED_POOL_ERROR =
	"attachDatabasePool: unexpected database pool error";
const REPORTER_THREW = "attachDatabasePool: onUnexpectedError threw";
const ALREADY_ATTACHED =
	"attachDatabasePool() was already called for this pool; the first onUnexpectedError stays attached and this one is ignored.";

export type DatabasePool = {
	on(event: "error", listener: (err: Error) => void): unknown;
};

export type AttachDatabasePoolOptions = {
	onUnexpectedError?: (err: Error) => void | Promise<void>;
};

function isDatabasePool(value: unknown): value is DatabasePool {
	return (
		typeof value === "object" &&
		value !== null &&
		"on" in value &&
		typeof value.on === "function"
	);
}

function isIdleDisconnect(err: Error): boolean {
	const code =
		"code" in err && typeof err.code === "string" ? err.code : undefined;
	return (
		(code !== undefined && IDLE_DISCONNECT_CODES.has(code)) ||
		err.message === "Connection terminated unexpectedly"
	);
}

function describeValue(value: unknown): string {
	if (value === null) {
		return "null";
	}
	return typeof value;
}

function isPromise(value: unknown): value is Promise<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

function requireDatabasePool(pool: unknown): DatabasePool {
	if (isDatabasePool(pool)) {
		return pool;
	}
	if (typeof pool === "object" && pool !== null) {
		throw new TypeError(
			"attachDatabasePool() requires a node-postgres Pool with an on() method, got an object without one",
		);
	}
	throw new TypeError(
		`attachDatabasePool() requires a node-postgres Pool, got ${describeValue(pool)}`,
	);
}

function resolveOnUnexpectedError(
	options: unknown,
): ((err: Error) => unknown) | undefined {
	if (options === undefined) {
		return undefined;
	}
	if (typeof options !== "object" || options === null) {
		throw new TypeError(
			`attachDatabasePool() options must be an object, got ${describeValue(options)}`,
		);
	}
	if (
		!("onUnexpectedError" in options) ||
		options.onUnexpectedError === undefined
	) {
		return undefined;
	}
	const handler = options.onUnexpectedError;
	if (typeof handler !== "function") {
		throw new TypeError(
			`attachDatabasePool() onUnexpectedError must be a function, got ${typeof handler}`,
		);
	}
	return (err: Error) => handler(err);
}

function reportUnexpectedError(
	err: Error,
	onUnexpectedError: ((err: Error) => unknown) | undefined,
): void {
	if (!onUnexpectedError) {
		console.error(UNEXPECTED_POOL_ERROR, err);
		return;
	}
	try {
		const result = onUnexpectedError(err);
		if (isPromise(result)) {
			result.catch((reporterError: unknown) => {
				console.error(UNEXPECTED_POOL_ERROR, err);
				console.error(REPORTER_THREW, reporterError);
			});
		}
	} catch (reporterError) {
		console.error(UNEXPECTED_POOL_ERROR, err);
		console.error(REPORTER_THREW, reporterError);
	}
}

export function attachDatabasePool(
	pool: DatabasePool,
	options?: AttachDatabasePoolOptions,
): void {
	const databasePool = requireDatabasePool(pool);
	const onUnexpectedError = resolveOnUnexpectedError(options);
	if (attached.has(databasePool)) {
		if (onUnexpectedError) {
			console.warn(ALREADY_ATTACHED);
		}
		return;
	}
	databasePool.on("error", (err) => {
		if (isIdleDisconnect(err)) {
			return;
		}
		reportUnexpectedError(err, onUnexpectedError);
	});
	attached.add(databasePool);
}
