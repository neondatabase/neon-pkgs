export type CatalogFetchOptions<T> = {
	urls: readonly string[];
	parse: (text: string) => T[];
	fallback: readonly T[];
	headers?: () => Record<string, string>;
	timeoutMs?: number;
	maxBytes?: number;
};

async function readCappedText(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error(`Catalog response exceeds the ${maxBytes}-byte limit.`);
	}
	const body = response.body;
	if (!body) {
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > maxBytes) {
			throw new Error(
				`Catalog response exceeds the ${maxBytes}-byte limit.`,
			);
		}
		return text;
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(
				`Catalog response exceeds the ${maxBytes}-byte limit.`,
			);
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return text;
}

/**
 * Fetch a catalog from the first healthy source. Invalid, empty, and
 * unreachable catalogs fall through to the next URL, then to the local
 * fallback. Catalog-specific parsing and validation stays with the caller.
 */
export async function fetchCatalog<T>(
	options: CatalogFetchOptions<T>,
): Promise<T[]> {
	for (const url of options.urls) {
		try {
			const response = await fetch(url, {
				headers: options.headers?.(),
				signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const text =
				options.maxBytes === undefined
					? await response.text()
					: await readCappedText(response, options.maxBytes);
			const entries = options.parse(text);
			if (entries.length > 0) return entries;
		} catch {
			// Try the next source. A remote catalog must not make local fallback
			// entries unavailable.
		}
	}
	return [...options.fallback];
}
