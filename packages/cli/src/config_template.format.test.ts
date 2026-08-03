import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { NeonConfigView } from "./config_format.js";
import {
	FUNCTION_TEMPLATE,
	NEON_SERVICES,
	type NeonService,
	renderNeonConfig,
	renderNeonConfigFromView,
} from "./config_template.js";

/**
 * Both renderers build TypeScript by concatenating strings, so indentation is only as correct
 * as the person who typed the spaces. Rather than assert a handful of expected files, run every
 * variant through Biome — the formatter this repo already uses — and require it to change
 * nothing. A miscounted space, a missing trailing comma, or a line long enough to need
 * wrapping all fail here instead of landing in a user's project.
 *
 * The style is passed explicitly (2-space indentation) rather than inherited from
 * `biome.json`, because the repo formats its own sources with tabs while the file we emit into
 * someone else's project uses spaces. That makes the flags the contract, not our config.
 */
const biomeBin = (): string => {
	// packages/cli/src → repo root. Biome is a root devDependency, so pnpm links it there.
	const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
	const bin = join(repoRoot, "node_modules", ".bin", "biome");
	if (!existsSync(bin)) {
		throw new Error(
			`Biome not found at ${bin}. Run \`pnpm install\` at the repository root.`,
		);
	}
	return bin;
};

const format = (source: string): string =>
	execFileSync(
		biomeBin(),
		[
			"format",
			"--stdin-file-path=neon.ts",
			"--indent-style=space",
			"--indent-width=2",
		],
		{ input: source, encoding: "utf8" },
	);

/** Every subset of the pickable services, so no combination of blocks goes unchecked. */
const serviceSubsets = (): NeonService[][] => {
	const subsets: NeonService[][] = [];
	for (let mask = 0; mask < 1 << NEON_SERVICES.length; mask++) {
		subsets.push(NEON_SERVICES.filter((_, i) => mask & (1 << i)));
	}
	return subsets;
};

/** Live-state shapes that exercise each seeded block, alone and together. */
const views: { name: string; view: NeonConfigView; branch: string }[] = [
	{ name: "empty", view: {}, branch: "main" },
	{
		name: "services only",
		view: { auth: true, dataApi: true },
		branch: "main",
	},
	{
		name: "buckets and functions",
		view: {
			preview: {
				buckets: {
					"user-uploads": { access: "public_read" },
					backups: { access: "private" },
				},
				functions: {
					resize: { name: "Resize Image" },
					thumb: { name: "Thumb" },
				},
			},
		},
		branch: "preview",
	},
	{
		name: "branch tuning",
		view: {
			branch: {
				parent: "main",
				ttl: "7d",
				protected: true,
				postgres: {
					computeSettings: {
						autoscalingLimitMinCu: 0.25,
						autoscalingLimitMaxCu: 4,
						suspendTimeout: "5m",
					},
				},
			},
		},
		branch: "dev",
	},
	{
		name: "everything",
		view: {
			auth: true,
			dataApi: true,
			preview: {
				buckets: { assets: { access: "private" } },
				functions: { hello: { name: "Hello World" } },
				credentials: [{ id: "credshort", scopes: ["storage:read"] }],
			},
			branch: {
				parent: "main",
				protected: true,
				postgres: { computeSettings: { suspendTimeout: false } },
			},
		},
		branch: "main",
	},
];

/**
 * Invariants a formatter does not check but a generated file still has to hold: spaces only
 * (the emitted file must not mix in a tab), no trailing whitespace, and exactly one closing
 * newline so the file is a clean diff the first time someone edits it.
 */
const expectCleanWhitespace = (source: string): void => {
	expect(source).not.toMatch(/\t/);
	expect(source).not.toMatch(/[ ]+$/m);
	expect(source.endsWith("\n")).toBe(true);
	expect(source.endsWith("\n\n")).toBe(false);
	for (const line of source.split("\n")) {
		const leading = line.match(/^ */)?.[0].length ?? 0;
		expect(leading % 2, `odd indentation on: ${line}`).toBe(0);
	}
};

describe("the scaffolded neon.ts is already formatted", () => {
	it.each(
		serviceSubsets().map((s) => [s.join("+") || "none", s] as const),
	)("services: %s", (_label, services) => {
		const source = renderNeonConfig([...services]);
		expect(format(source)).toBe(source);
		expectCleanWhitespace(source);
	});

	it("the scaffolded function handler", () => {
		expect(format(FUNCTION_TEMPLATE)).toBe(FUNCTION_TEMPLATE);
		expectCleanWhitespace(FUNCTION_TEMPLATE);
	});

	it.each(
		views.map((v) => [v.name, v] as const),
	)("seeded from a branch: %s", (_label, { view, branch }) => {
		const { source } = renderNeonConfigFromView(view, branch);
		expect(format(source)).toBe(source);
		expectCleanWhitespace(source);
	});
});
