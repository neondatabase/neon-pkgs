export class InitCancelled extends Error {
	constructor() {
		super("Aborted.");
		this.name = "InitCancelled";
	}
}

export const restoreCursor = (): void => {
	process.stdout.write("\x1B[?25h");
	process.stdout.write("\n");
};

export const throwIfAborted = (state: { aborted: boolean }): void => {
	if (state.aborted) {
		restoreCursor();
		throw new InitCancelled();
	}
};
