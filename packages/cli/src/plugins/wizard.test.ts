import { describe, expect, test } from "vitest";

import { pluginsInstallSummary } from "./wizard.js";

describe("pluginsInstallSummary", () => {
	test("names project-scoped, agents, and the plugin id", () => {
		expect(
			pluginsInstallSummary({
				scope: "project",
				agents: ["cursor"],
			}),
		).toBe(
			["Config  project", "Agents  Cursor", "Plugin  neon-postgres"].join(
				"\n",
			),
		);
	});

	test("names user-level without repos", () => {
		const text = pluginsInstallSummary({
			scope: "global",
			agents: ["cursor", "claude-code"],
		});
		expect(text).toContain("user");
		expect(text).toContain("neon-postgres");
		expect(text).not.toContain("neondatabase/");
	});
});
