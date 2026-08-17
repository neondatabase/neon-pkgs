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

export type DatabasePool = {
	on(event: "error", listener: (err: Error) => void): unknown;
};

export type AttachDatabasePoolOptions = {
	onUnexpectedError?: (err: Error) => void;
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

function resolveOnUnexpectedError(
	options: unknown,
): ((err: Error) => void) | undefined {
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
	return (err: Error) => {
		handler(err);
	};
}

export function attachDatabasePool(
	pool: DatabasePool,
	options?: AttachDatabasePoolOptions,
): void {
	if (!isDatabasePool(pool)) {
		throw new TypeError(
			`attachDatabasePool() requires a node-postgres Pool, got ${describeValue(pool)}`,
		);
	}
	if (attached.has(pool)) {
		return;
	}
	const onUnexpectedError = resolveOnUnexpectedError(options);
	pool.on("error", (err) => {
		if (isIdleDisconnect(err)) {
			return;
		}
		if (onUnexpectedError) {
			onUnexpectedError(err);
			return;
		}
		console.error(err);
	});
	attached.add(pool);
}
