import { describe, expect, test, vi } from "vitest";

import { pickAgentSetupInteractively } from "./wizard.js";

describe("pickAgentSetupInteractively", () => {
	test("refuses when there is no TTY", async () => {
		vi.stubEnv("CI", "true");
		await expect(pickAgentSetupInteractively()).rejects.toThrow(
			/No interactive terminal/,
		);
		vi.unstubAllEnvs();
	});
});
