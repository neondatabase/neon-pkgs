export function toISOString(
	date: string | Date | number | undefined | null,
): string {
	if (!date) {
		return new Date().toISOString(); // Fallback to current time
	}
	if (typeof date === "string") {
		return date; // Already ISO string
	}
	if (typeof date === "number") {
		return new Date(date).toISOString(); // Convert timestamp to ISO string
	}
	// Date object
	return date.toISOString();
}
