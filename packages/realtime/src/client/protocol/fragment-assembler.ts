import { ProtocolError } from "./codec.js";

/**
 * Maximum assembled message length in JS string code units (UTF-16 code units).
 * This is 32 MiB as specified in the protocol.
 */
export const MAX_ASSEMBLED_MESSAGE_LENGTH = 33_554_432;

/**
 * Manages reassembly of fragmented server messages.
 * Only one stream can be open at a time; streaming is terminated when
 * a complete message arrives or an error occurs.
 */
export class FragmentAssembler {
	private streamId?: string;
	private fragments: string[] = [];
	private assembledLength = 0;

	/**
	 * Process a fragment message.
	 * Returns the complete assembled message when the stream is finished,
	 * or undefined while accumulating fragments.
	 */
	processFragment(
		id: string,
		index: number,
		last: boolean,
		data: string,
	): string | undefined {
		// Check if we're starting a new stream
		if (this.streamId === undefined) {
			if (index !== 0) {
				throw new ProtocolError(
					"fragment index 0 required to open a stream",
				);
			}
			if (data.length > MAX_ASSEMBLED_MESSAGE_LENGTH) {
				throw new ProtocolError(
					`assembled message exceeds maximum length of ${MAX_ASSEMBLED_MESSAGE_LENGTH}`,
				);
			}
			this.streamId = id;
			this.fragments = [data];
			this.assembledLength = data.length;

			if (last) {
				return this.finishStream();
			}
			return undefined;
		}

		// We have an open stream
		if (id !== this.streamId) {
			throw new ProtocolError("fragment id changed mid-stream");
		}

		const expectedIndex = this.fragments.length;
		if (index !== expectedIndex) {
			throw new ProtocolError(
				`fragment index out of order: expected ${expectedIndex}, got ${index}`,
			);
		}

		// Check if adding this fragment would exceed the limit
		const newLength = this.assembledLength + data.length;
		if (newLength > MAX_ASSEMBLED_MESSAGE_LENGTH) {
			this.streamId = undefined;
			this.fragments = [];
			this.assembledLength = 0;
			throw new ProtocolError(
				`assembled message exceeds maximum length of ${MAX_ASSEMBLED_MESSAGE_LENGTH}`,
			);
		}

		this.fragments.push(data);
		this.assembledLength = newLength;

		if (last) {
			return this.finishStream();
		}

		return undefined;
	}

	/**
	 * Finish a currently open stream and return the assembled message.
	 * Called when the last fragment arrives.
	 */
	private finishStream(): string {
		const assembled = this.fragments.join("");
		this.reset();
		return assembled;
	}

	/**
	 * Reset the assembler, discarding any open stream.
	 * Called when the connection closes or resets.
	 */
	reset(): void {
		this.streamId = undefined;
		this.fragments = [];
		this.assembledLength = 0;
	}

	/**
	 * Check if a stream is currently open.
	 */
	isOpen(): boolean {
		return this.streamId !== undefined;
	}
}
