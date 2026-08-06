import { writeSync } from "node:fs";

/**
 * Write `text` to a file descriptor and do not return until all of it is out.
 *
 * `process.stdout.write` is asynchronous when stdout is a pipe — which it is whenever the
 * caller is an agent or a script capturing output — so a `process.exit()` on the next line
 * discards whatever has not been flushed. The caller sees an exit code and empty stdout.
 *
 * Use this for any final message that is followed by `process.exit`.
 */
export function writeAllSync(fd: number, text: string): void {
	let buffer = Buffer.from(text, "utf8");
	while (buffer.length > 0) {
		try {
			buffer = buffer.subarray(writeSync(fd, buffer));
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EAGAIN") {
				// Wait for the reader rather than spinning on it. A pipe nobody is draining
				// would otherwise burn a core until it is; failure output is small enough
				// that this should never be reached, which is the reason to bound it rather
				// than assume so.
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
				continue;
			}
			// The reader closed the pipe (`neon … | head`). There is nobody left to tell,
			// and this is the last thing the process does, so stop rather than throw.
			if (code === "EPIPE") return;
			// Anything else means the write did not happen and the caller is about to exit
			// as though it had. Swallowing it turns a lost payload into an apparent success.
			throw err;
		}
	}
}

/** File descriptors, named so call sites read as the stream they mean. */
export const STDOUT_FD = 1;
export const STDERR_FD = 2;
