import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({
	isAuthenticated: vi.fn().mockResolvedValue(true),
}));

vi.mock("../inspect.js", () => ({
	inspectProject: vi.fn(),
}));

import { isAuthenticated } from "../auth.js";
import { inspectProject } from "../inspect.js";
import { handleStatusPhase } from "./status.js";

const mockIsAuthenticated = vi.mocked(isAuthenticated);
const mockInspect = vi.mocked(inspectProject);

describe("handleStatusPhase", () => {
	beforeEach(() => {
		mockIsAuthenticated.mockResolvedValue(true);
		mockInspect.mockResolvedValue({
			databaseUrl: true,
			mcpConfigured: true,
			skillsInstalled: false,
			migrationTool: "none",
			migrationDir: "none",
		});
	});

	test("recommends skills when the agent has a skills target", async () => {
		const result = await handleStatusPhase({ agent: "cursor" });
		expect(
			result.recommendations.some((r) =>
				r.message.includes("agent skills"),
			),
		).toBe(true);
	});

	test("does not recommend skills for grok-build", async () => {
		const result = await handleStatusPhase({ agent: "grok-build" });
		expect(
			result.recommendations.some((r) =>
				r.message.includes("agent skills"),
			),
		).toBe(false);
	});
});
