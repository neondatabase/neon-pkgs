console.warn(
	"\x1b[33m%s\x1b[0m",
	"DEPRECATION: vite-plugin-db is deprecated. Use Claimable Neon in the Neon CLI: npx neon@latest claim create",
);
console.warn("");

/**
 * @deprecated Use Claimable Neon in the Neon CLI: `npx neon@latest claim create`.
 */
export * from "vite-plugin-neon-new";
