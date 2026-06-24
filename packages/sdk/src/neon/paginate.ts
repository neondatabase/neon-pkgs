import { toNeonError } from "./errors.js";
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
	readonly #signal?: AbortSignal;

	constructor(
		fetchPage: (
			cursor: string | undefined,
			signal?: AbortSignal,
		) => Promise<RawResult<D>>,
		mapPage: (data: D) => Page<T>,
		signal?: AbortSignal,
	) {
		this.#fetchPage = fetchPage;
		this.#mapPage = mapPage;
		this.#signal = signal;
	}

	async page(cursor?: string): Promise<NeonResult<Page<T>>> {
		const raw = await this.#fetchPage(cursor, this.#signal);
		if (raw.error || raw.data === undefined) {
			return err(toNeonError(raw.error, raw.response));
		}
		return ok(this.#mapPage(raw.data));
	}

	async all(): Promise<NeonResult<T[]>> {
		const items: T[] = [];
		let cursor: string | undefined;
		while (true) {
			const result = await this.page(cursor);
			if (result.error) return err(result.error);
			items.push(...result.data.items);
			if (!result.data.cursor || result.data.items.length === 0) break;
			cursor = result.data.cursor;
		}
		return ok(items);
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		let cursor: string | undefined;
		while (true) {
			const result = await this.page(cursor);
			if (result.error) throw result.error;
			yield* result.data.items;
			if (!result.data.cursor || result.data.items.length === 0) break;
			cursor = result.data.cursor;
		}
	}
}

/**
 * Build a {@link Paginated} list from a page fetcher and a page mapper. The response-body
 * type `D` is inferred and erased from the public `Paginated<T>` return.
 */
export function paginate<T, D>(
	fetchPage: (
		cursor: string | undefined,
		signal?: AbortSignal,
	) => Promise<RawResult<D>>,
	mapPage: (data: D) => Page<T>,
	signal?: AbortSignal,
): Paginated<T> {
	return new PaginatedList(fetchPage, mapPage, signal);
}
