/**
 * Starts a read now and keeps an unread rejection from crashing the process; the caller
 * awaits it (and sees the error) when its turn comes. Also turns a synchronous throw from
 * a custom adapter into a rejection.
 */
export function started<T>(read: () => Promise<T>): Promise<T> {
	const promise = Promise.resolve().then(read);
	promise.catch(() => undefined);
	return promise;
}
