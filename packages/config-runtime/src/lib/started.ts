/**
 * Starts a read now and keeps an unread rejection from crashing the process; the caller
 * awaits it (and sees the error) when its turn comes. Also turns a synchronous throw from
 * a custom adapter into a rejection. The read's own promise is returned as is, so a
 * concurrent group settles in the same order as when its members are called directly.
 */
export function started<T>(read: () => Promise<T>): Promise<T> {
	let promise: Promise<T>;
	try {
		promise = Promise.resolve(read());
	} catch (error) {
		promise = Promise.reject(error);
	}
	promise.catch(() => undefined);
	return promise;
}
