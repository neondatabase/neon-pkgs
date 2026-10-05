/** Return a test value after asserting that it exists. */
export function defined<T>(value: T | null | undefined): T {
	if (value === undefined || value === null) {
		throw new Error("Expected test value to be defined");
	}
	return value;
}
