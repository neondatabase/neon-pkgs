const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;
const CLEAR_LINE = "\r\x1b[2K";

export function createThinkingSpinner(opts: {
	out: NodeJS.WritableStream;
	isTty: boolean;
}) {
	let message = "Thinking";
	let frame = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopped = false;

	const paint = () => {
		if (!opts.isTty || stopped) {
			return;
		}
		const glyph = FRAMES[frame % FRAMES.length];
		frame += 1;
		opts.out.write(`${CLEAR_LINE}${glyph} ${message}`);
	};

	return {
		start() {
			if (!opts.isTty || stopped) {
				return;
			}
			paint();
			timer = setInterval(paint, INTERVAL_MS);
			timer.unref();
		},
		setMessage(next: string) {
			message = next;
			paint();
		},
		stop() {
			if (stopped) {
				return;
			}
			stopped = true;
			if (timer) {
				clearInterval(timer);
			}
			if (opts.isTty) {
				opts.out.write(CLEAR_LINE);
			}
		},
	};
}
