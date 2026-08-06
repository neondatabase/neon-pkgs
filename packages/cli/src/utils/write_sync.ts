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
			if ((err as NodeJS.ErrnoException).code !== "EAGAIN") return;
			// Wait for the reader rather than spinning on it. A pipe nobody is draining would
			// otherwise burn a core until it is; failure output is small enough that this
			// should never be reached, which is the reason to bound it rather than assume so.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
}

/** File descriptors, named so call sites read as the stream they mean. */
export const STDOUT_FD = 1;
export const STDERR_FD = 2;
