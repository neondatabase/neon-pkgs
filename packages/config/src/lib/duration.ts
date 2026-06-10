import type { DurationString } from "./types.js";

/**
 * Parse a duration value into whole seconds.
 *
 * Accepted formats:
 * - a positive finite **number** → interpreted as seconds (must be an integer)
 * - a **string** of the form `<integer><unit>` where unit is one of `s`, `m`, `h`, `d`, `w`
 *   (e.g. `30s`, `5m`, `1h`, `7d`, `2w`)
 *
 * A **unit is required** on strings: a bare numeric string like `"7"` is rejected — pass a
 * `number` (`7`) for raw seconds instead. This removes the ambiguity where `"7"` silently
 * meant 7 seconds rather than, say, `"7d"`.
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

	// A bare numeric string is rejected on purpose: pass a number for raw seconds, or add a
	// unit (e.g. "7d"). Detected explicitly so we can give a targeted hint instead of the
	// generic "invalid duration" message.
	if (/^\d+$/.test(trimmed)) {
		return {
			error: `duration string "${input}" is missing a unit; add one of s, m, h, d, w (e.g. "${trimmed}d") or pass ${trimmed} as a number for seconds`,
		};
	}

	const unitMatch = /^(\d+)([smhdw])$/i.exec(trimmed);
	if (!unitMatch) {
		return {
			error: `invalid duration "${input}"; expected an integer followed by one of: s, m, h, d, w (e.g. "30s", "1h", "7d")`,
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
 * when no clean unit boundary matches). The output always carries a unit, so it is a valid
 * {@link DurationString}.
 */
export function formatDurationSeconds(totalSeconds: number): DurationString {
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

/**
 * Parse a suspend timeout value into seconds for the Neon API.
 *
 * Accepted formats:
 * - `false` → -1 (never suspend)
 * - `undefined` → 0 (use platform default)
 * - duration string → parsed seconds ("5m", "1h", "7d")
 * - number → validated seconds (must be 60-604800 or -1/0)
 *
 * Returns `{ seconds }` on success or `{ error }` on failure. Pure function — never throws.
 */
export function parseSuspendTimeout(
	input: false | string | number | undefined,
): { seconds: number } | { error: string } {
	// false means "never suspend"
	if (input === false) return { seconds: -1 };

	// undefined means "use platform default"
	if (input === undefined) return { seconds: 0 };

	// If it's a number, validate the range
	if (typeof input === "number") {
		if (!Number.isFinite(input))
			return { error: `not a finite number: ${input}` };
		if (!Number.isInteger(input))
			return { error: `must be an integer: ${input}` };

		// Allow special values: -1 (never), 0 (default)
		if (input === -1 || input === 0) return { seconds: input };

		// Validate range for custom timeout: 60s (1 min) to 604800s (1 week)
		if (input < 60 || input > 604_800) {
			return {
				error: `suspend timeout must be between 60 and 604800 seconds (1 minute to 1 week), got ${input}`,
			};
		}
		return { seconds: input };
	}

	// Parse duration string
	const result = parseDuration(input);
	if ("error" in result) return result;

	// Validate the parsed duration is in the valid range
	const { seconds } = result;
	if (seconds < 60 || seconds > 604_800) {
		return {
			error: `suspend timeout must be between 60 and 604800 seconds (1 minute to 1 week), "${input}" = ${seconds}s`,
		};
	}

	return { seconds };
}

/**
 * Format a suspend timeout value from API seconds back to the user-facing type.
 * Returns `false` for -1 (never suspend), `undefined` for 0 (default), or a duration string.
 */
export function formatSuspendTimeout(
	seconds: number,
): false | DurationString | undefined {
	if (seconds === -1) return false; // never suspend
	if (seconds === 0) return undefined; // platform default
	return formatDurationSeconds(seconds);
}
