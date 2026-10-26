/** The rule the platform enforces on function slugs, so a bad one fails before any write. */
export const FUNCTION_SLUG_PATTERN = /^[a-z0-9]{1,20}$/;

export const FUNCTION_SLUG_HELP =
	"Use 1-20 lowercase letters and digits (no hyphens or other characters).";

export const deriveFunctionSlug = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 20);
