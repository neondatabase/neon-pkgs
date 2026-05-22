/**
 * Parse a TTL value into whole seconds.
 *
 * Accepted formats:
 * - a positive finite number → interpreted as seconds (must be an integer)
 * - a positive integer string ("3600") → seconds
 * - `<number><unit>` where unit is one of `s`, `m`, `h`, `d`, `w` (e.g. `30s`, `5m`, `1h`, `7d`, `2w`)
 *
 * Returns `{ seconds }` on success or `{ error }` on failure. Pure function — never throws.
 */
export function parseDuration(
	input: string | number,
): { seconds: number } | { error: string } {
	if (typeof input === "number") {
		if (!Number.isFinite(input))
			return { error: `not a finite number: ${input}` };
		if (!Number.isInteger(input))
			return {
				error: `must be an integer when passed as number: ${input}`,
			};
		if (input <= 0) return { error: `must be > 0, got ${input}` };
		return { seconds: input };
	}

	const trimmed = input.trim();
	if (trimmed === "") return { error: "duration string is empty" };

	const numericMatch = /^(\d+)$/.exec(trimmed);
	if (numericMatch) {
		const n = Number(numericMatch[1]);
		if (n <= 0) return { error: `must be > 0, got "${trimmed}"` };
		return { seconds: n };
	}

	const unitMatch = /^(\d+)([smhdw])$/i.exec(trimmed);
	if (!unitMatch) {
		return {
			error: `invalid duration "${input}"; expected a number followed by one of: s, m, h, d, w (e.g. "30s", "1h", "7d")`,
		};
	}

	const value = Number(unitMatch[1]);
	const unit = unitMatch[2].toLowerCase() as "s" | "m" | "h" | "d" | "w";
	if (value <= 0) return { error: `must be > 0, got "${trimmed}"` };

	const seconds = value * UNIT_SECONDS[unit];
	return { seconds };
}

const UNIT_SECONDS = {
	s: 1,
	m: 60,
	h: 60 * 60,
	d: 24 * 60 * 60,
	w: 7 * 24 * 60 * 60,
} as const;

/**
 * Render a TTL in seconds back to the canonical "<n><unit>" form. Used for round-trip
 * serialization when {@link pullConfig} emits a TTL value (it always falls back to seconds
 * when no clean unit boundary matches).
 */
export function formatDurationSeconds(totalSeconds: number): string {
	if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
		throw new RangeError(
			`formatDurationSeconds expected a positive finite number, got ${totalSeconds}`,
		);
	}
	const candidates = [
		["w", UNIT_SECONDS.w],
		["d", UNIT_SECONDS.d],
		["h", UNIT_SECONDS.h],
		["m", UNIT_SECONDS.m],
	] as const;
	for (const [unit, perUnit] of candidates) {
		if (totalSeconds % perUnit === 0) {
			return `${totalSeconds / perUnit}${unit}`;
		}
	}
	return `${totalSeconds}s`;
}
