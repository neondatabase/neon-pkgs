export class InitCancelled extends Error {
	constructor() {
		super("Aborted.");
		this.name = "InitCancelled";
	}
}

/**
 * Rejects with {@link InitCancelled} on SIGINT while `work` is pending, so a step that runs
 * fully in-process (no spawned child of its own to die and report the signal back) still
 * unwinds through `runInit`'s normal cancellation handling — the "Neon setup cancelled."
 * summary and the funnel's final telemetry — instead of Node's default SIGINT disposition
 * killing the process with no chance to run either.
 *
 * Does not cancel `work` itself: there is no cooperative cancellation to ask for here, so a
 * lost race leaves it running in the background, its eventual settlement discarded. That is
 * fine — the process is already unwinding to exit on the `InitCancelled` path.
 */
export const raceSigint = <T>(work: Promise<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		const onSigint = (): void => reject(new InitCancelled());
		process.once("SIGINT", onSigint);
		const stop = (): void => {
			process.removeListener("SIGINT", onSigint);
		};
		work.then(
			(value) => {
				stop();
				resolve(value);
			},
			(error: unknown) => {
				stop();
				reject(error);
			},
		);
	});

export const restoreCursor = (): void => {
	process.stdout.write("\x1B[?25h");
	process.stdout.write("\n");
};

export const restoreCursorVisibilityOnAbort = (state: {
	aborted: boolean;
}): void => {
	if (state.aborted) {
		process.stdout.write("\x1B[?25h");
	}
};
