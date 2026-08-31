/**
 * @deprecated Use Claimable Neon in the Neon CLI: `npx neon@latest claim create`.
 */

console.warn(
	"\x1b[33m%s\x1b[0m",
	"DEPRECATION: neondb is deprecated. Use Claimable Neon in the Neon CLI: npx neon@latest claim create",
);
console.warn("");

// Re-export everything from neon-new
export * from "neon-new/sdk";
