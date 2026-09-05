import { cancelled, type Deadline, runBounded } from "./deadline.js";
import { isNeonError, toNeonError } from "./errors.js";
import { err, type NeonResult, ok } from "./result.js";

export interface Page<T> {
	items: T[];
	/** Cursor for the next page, when more results exist. */
	cursor?: string;
}

interface RawResult<D> {
	data?: D | undefined;
	error?: unknown;
	response?: Response | undefined;
}

/**
 * A lazy, cursor-paginated list. `all()` / `page()` return the `{ data, error }` envelope;
 * the async iterator streams items lazily and throws on a page-fetch error.
 *
 * Note: pagination helpers always use the result envelope (the iterator is the throwing
 * form) regardless of the client's `throwOnError` setting.
 */
export interface Paginated<T> extends AsyncIterable<T> {
	/** Fetch a single page (optionally from a cursor). */
	page(cursor?: string): Promise<NeonResult<Page<T>>>;
	/** Fetch and concatenate every page. */
	all(): Promise<NeonResult<T[]>>;
}

class PaginatedList<T, D> implements Paginated<T> {
	readonly #fetchPage: (
		cursor: string | undefined,
		signal?: AbortSignal,
	) => Promise<RawResult<D>>;
	readonly #mapPage: (data: D) => Page<T>;
	readonly #newDeadline: () => Deadline;

	constructor(
		fetchPage: (
			cursor: string | undefined,
			signal?: AbortSignal,
		) => Promise<RawResult<D>>,
		mapPage: (data: D) => Page<T>,
		newDeadline: () => Deadline,
	) {
		this.#fetchPage = fetchPage;
		this.#mapPage = mapPage;
		this.#newDeadline = newDeadline;
	}

	async #page(
		cursor: string | undefined,
		deadline: Deadline,
	): Promise<NeonResult<Page<T>>> {
		let raw: RawResult<D> | undefined;
		try {
			// Bounded the same way the execution core bounds a request: the signal alone
			// does not cover the phases before `fetch` is reached, so a slow auth provider
			// would otherwise outlast the deadline.
			raw = await runBounded(deadline, () =>
				this.#fetchPage(cursor, deadline.signal),
			);
		} catch (error) {
			return err(cancelled(deadline) ?? toNeonError(error, undefined));
		}
		const cancellation = cancelled(deadline);
		if (cancellation) return err(cancellation);
		if (raw === undefined || raw.error || raw.data === undefined) {
			// A fetcher that already classified the failure keeps its own error.
			// Re-deriving one from the response would mislabel a fault the SDK
			// found in a 200 body as an API error with a 2xx status.
			if (isNeonError(raw?.error)) return err(raw.error);
			return err(toNeonError(raw?.error, raw?.response));
		}
		return ok(this.#mapPage(raw.data));
	}

	async page(cursor?: string): Promise<NeonResult<Page<T>>> {
		const deadline = this.#newDeadline();
		try {
			return await this.#page(cursor, deadline);
		} finally {
			deadline.dispose();
		}
	}

	/**
	 * One deadline covers the whole walk, not each page: `all()` is a single operation
	 * from the caller's side, and a per-page budget would leave an unbounded number of
	 * pages unbounded in total.
	 */
	async all(): Promise<NeonResult<T[]>> {
		const deadline = this.#newDeadline();
		try {
			const items: T[] = [];
			let cursor: string | undefined;
			while (true) {
				const result = await this.#page(cursor, deadline);
				if (result.error) return err(result.error);
				items.push(...result.data.items);
				if (!result.data.cursor || result.data.items.length === 0)
					break;
				cursor = result.data.cursor;
			}
			return ok(items);
		} finally {
			deadline.dispose();
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		const deadline = this.#newDeadline();
		try {
			let cursor: string | undefined;
			while (true) {
				const result = await this.#page(cursor, deadline);
				if (result.error) throw result.error;
				yield* result.data.items;
				if (!result.data.cursor || result.data.items.length === 0)
					break;
				cursor = result.data.cursor;
			}
		} finally {
			deadline.dispose();
		}
	}
}

/**
 * Build a {@link Paginated} list from a page fetcher and a page mapper. The response-body
 * type `D` is inferred and erased from the public `Paginated<T>` return.
 *
 * `newDeadline` is called once per consumption — each `page()`, each `all()`, each
 * iteration — because a `Paginated` is lazy and may be consumed more than once, so a
 * deadline created when the list was built would already be spent.
 */
export function paginate<T, D>(
	fetchPage: (
		cursor: string | undefined,
		signal?: AbortSignal,
	) => Promise<RawResult<D>>,
	mapPage: (data: D) => Page<T>,
	newDeadline: () => Deadline,
): Paginated<T> {
	return new PaginatedList(fetchPage, mapPage, newDeadline);
}
