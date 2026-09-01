import { closeSync, openSync, statSync, unlinkSync } from "node:fs";

const WAIT_MS = 20_000;
const RETRY_MS = 50;
const STALE_MS = 60_000;

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const isEexist = (err: unknown): boolean =>
	err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST";

const isStale = (path: string): boolean => {
	try {
		return Date.now() - statSync(path).mtimeMs > STALE_MS;
	} catch {
		return true;
	}
};

/**
 * Serialize exchanges because replaying a one-time refresh token can revoke the
 * newly issued token family.
 */
export const withExclusiveLock = async <T>(
	lockPath: string,
	fn: () => Promise<T>,
): Promise<T> => {
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			try {
				return await fn();
			} finally {
				closeSync(fd);
				try {
					unlinkSync(lockPath);
				} catch {
					// A stale-lock cleanup can win this unlink race after `fn` finishes.
				}
			}
		} catch (err) {
			if (!isEexist(err)) throw err;
			if (isStale(lockPath)) {
				try {
					unlinkSync(lockPath);
				} catch {
					// Another waiter may remove the stale file first.
				}
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`Could not lock ${lockPath} to refresh the stored session. Retry the command.`,
				);
			}
			await delay(RETRY_MS);
		}
	}
};
