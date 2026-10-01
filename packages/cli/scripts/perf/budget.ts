/** Module identity (a package name, or a `dist/` path inside `neon`) → modules loaded from it. */
export type Inventory = Record<string, number>;

/** `METHOD /path` → number of times the CLI sent it. */
export type RequestCounts = Record<string, number>;

export type ScenarioMeasurement = {
	modules: number;
	requests: RequestCounts;
	inventory: Inventory;
};

export type Budgets = {
	scenarios: Record<string, ScenarioMeasurement>;
};

/** What `module-hook.mjs` writes: loaded file URLs in load order, and each URL's first importer. */
export type ModuleLog = {
	loaded: string[];
	parents: Record<string, string>;
};

export type Growth = { identity: string; budget: number; actual: number };

export const UPDATE_COMMAND =
	"PERF_BUDGETS_UPDATE=1 pnpm --filter neon test:perf";
export const REPRODUCE_COMMAND = "pnpm --filter neon test:perf";

const CHUNK_HASH = /^(dist\/_chunks\/.+)-[\w-]{8}\.js$/;

/**
 * The stable name for a module file. A third-party file is its package name. A file we own is
 * named down to the file so a failure can point at it: `neon`'s own files are their path under
 * the package root with the tsdown chunk hash removed (so the identity survives rebuilds), and a
 * workspace package's files are `<package>/<path>`.
 */
export const moduleIdentity = (
	pkg: { name: string; relativePath: string; workspace: boolean },
	cliPackageName: string,
): string => {
	if (pkg.name === cliPackageName) {
		return pkg.relativePath.replace(CHUNK_HASH, "$1.js");
	}
	return pkg.workspace ? `${pkg.name}/${pkg.relativePath}` : pkg.name;
};

export const buildInventory = (identities: string[]): Inventory => {
	const inventory: Inventory = {};
	for (const identity of identities) {
		inventory[identity] = (inventory[identity] ?? 0) + 1;
	}
	return sortKeys(inventory);
};

export const sortKeys = <T>(record: Record<string, T>): Record<string, T> =>
	Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);

/** Entries that grew or are new, largest growth first. */
export const growth = (
	budget: Record<string, number>,
	actual: Record<string, number>,
): Growth[] =>
	Object.entries(actual)
		.map(([identity, count]) => ({
			identity,
			budget: budget[identity] ?? 0,
			actual: count,
		}))
		.filter((entry) => entry.actual > entry.budget)
		.sort((a, b) => b.actual - b.budget - (a.actual - a.budget));

/**
 * The importer chain from the entry point to `url`, as identities, with consecutive files of
 * the same package collapsed so the chain reads as the hops that matter.
 */
export const importChain = (
	log: ModuleLog,
	url: string,
	identify: (url: string) => string,
): string[] => {
	const chain: string[] = [];
	const seen = new Set<string>();
	let current: string | undefined = url;
	while (current && !seen.has(current)) {
		seen.add(current);
		const identity = identify(current);
		if (chain[0] !== identity) {
			chain.unshift(identity);
		}
		current = log.parents[current];
	}
	return chain;
};

export const formatModuleFailure = (input: {
	scenario: string;
	budget: number;
	actual: number;
	culprits: Array<Growth & { chain: string[] }>;
}): string => {
	const lines = [
		`\`neon ${input.scenario}\` loaded ${input.actual} modules (budget ${input.budget}).`,
		"",
		"Grew since the budget was recorded (identity: budget -> actual):",
		...input.culprits
			.slice(0, 10)
			.map(
				(c) =>
					`  ${c.identity}: ${c.budget} -> ${c.actual}\n    import chain: ${c.chain.join(" -> ")}`,
			),
	];
	if (input.culprits.length > 10) {
		lines.push(`  ... and ${input.culprits.length - 10} more`);
	}
	lines.push(
		"",
		"`dist/<path>.js` in a chain is built from packages/cli/src/<path>.ts; `dist/_chunks/*` holds bundled `@neon-internals/*` code (internals/*/src); `@neon/<pkg>/dist/<path>.js` is built from that workspace package's src/ in this repo.",
		"Likely anti-pattern: a static import that puts code on the startup path of commands that never use it.",
		"Fix: import it where it is used, inside the handler or function that needs it (`await import(...)`), or import a narrower module.",
		`Verify: ${REPRODUCE_COMMAND}`,
		`If the growth is intended (a new dependency this command really needs at startup): ${UPDATE_COMMAND}, commit packages/cli/perf-budgets.json, and say why in the PR.`,
	);
	return lines.join("\n");
};

export const formatRequestFailure = (input: {
	scenario: string;
	budget: RequestCounts;
	actual: RequestCounts;
}): string => {
	const grown = growth(input.budget, input.actual);
	return [
		`\`neon ${input.scenario}\` sent more Neon API requests than its budget (request: budget -> actual):`,
		...grown.map((g) => `  ${g.identity}: ${g.budget} -> ${g.actual}`),
		"",
		"Likely anti-pattern: a duplicate or extra API round trip. Each one costs a network round trip to console.neon.tech for every user of this command.",
		"Fix: reuse the response you already have (pass it down instead of refetching), or drop the call.",
		`Verify: ${REPRODUCE_COMMAND}`,
		`If the new request is intended: ${UPDATE_COMMAND}, commit packages/cli/perf-budgets.json, and say why in the PR.`,
	].join("\n");
};

/** A note for a scenario that now loads fewer modules or sends fewer requests than its budget. */
export const formatShrinkNote = (
	scenario: string,
	budget: ScenarioMeasurement,
	actual: ScenarioMeasurement,
): string | undefined => {
	const lower = [
		actual.modules < budget.modules &&
			`modules ${budget.modules} -> ${actual.modules}`,
		...growth(actual.requests, budget.requests).map(
			(g) => `${g.identity} ${g.actual} -> ${g.budget}`,
		),
	].filter((item): item is string => typeof item === "string");
	return lower.length > 0
		? `\`neon ${scenario}\` is below its budget (${lower.join(", ")}). Lock in the improvement so it can't silently regress: ${UPDATE_COMMAND}`
		: undefined;
};
