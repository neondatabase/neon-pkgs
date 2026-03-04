/**
 * @deprecated This package has been renamed to "neon-new".
 * Please update your imports: import { instantPostgres } from 'neon-new/sdk'
 */

console.warn(
	"\x1b[33m%s\x1b[0m",
	'⚠️  DEPRECATION WARNING: The "get-db" package has been renamed to "neon-new".',
);
console.warn(
	"\x1b[33m%s\x1b[0m",
	'   Please update your imports to use "neon-new/sdk" or "neon-new/launchpad" instead.',
);
console.warn("");

// Re-export everything from neon-new
export * from "neon-new/sdk";
