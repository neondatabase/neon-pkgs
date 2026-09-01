export const DEPRECATION_MESSAGE =
	"neon-new and vite-plugin-neon-new are deprecated. Use Claimable Neon in the Neon CLI: npx neon@latest claim create";

let warned = false;

export function warnDeprecatedOnce(): void {
	if (warned) {
		return;
	}
	warned = true;
	console.warn(DEPRECATION_MESSAGE);
}
