console.warn(
	"\x1b[33m%s\x1b[0m",
	'⚠️  DEPRECATION WARNING: The "@neondatabase/vite-plugin-postgres" package has been renamed to "vite-plugin-neon-new".',
);
console.warn(
	"\x1b[33m%s\x1b[0m",
	'   Please update your imports to use "vite-plugin-neon-new" instead.',
);
console.warn("");

/**
 * @deprecated This package has been renamed to "vite-plugin-neon-new".
 * @see https://www.npmjs.com/package/vite-plugin-neon-new
 */
export * from "vite-plugin-neon-new";
