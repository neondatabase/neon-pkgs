import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../auth.js", () => ({
	isAuthenticated: vi.fn(),
}));

import { isAuthenticated } from "../auth.js";
import { handleAuthPhase } from "./auth.js";

const mockIsAuthenticated = vi.mocked(isAuthenticated);

describe("handleAuthPhase", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test("asks user about account with inline actions when not authed", async () => {
		mockIsAuthenticated.mockResolvedValue(false);

		const result = await handleAuthPhase({});

		expect(result.phase).toBe("auth");
		expect(result.status).toBe("required");
		expect(result.nextAction.type).toBe("ask_user");
		if (result.nextAction.type === "ask_user") {
			const existing = result.nextAction.responseMapping.existing_account;
			expect("action" in existing).toBe(true);
			if ("action" in existing) {
				expect(existing.action.type).toBe("run_command");
			}
			const newAccount = result.nextAction.responseMapping.new_account;
			expect("action" in newAccount).toBe(true);
			if ("action" in newAccount) {
				expect(newAccount.action.type).toBe("agent_action");
			}
		}
	});

	test("returns verified with run_neon_init when already authenticated", async () => {
		mockIsAuthenticated.mockResolvedValue(true);

		const result = await handleAuthPhase({});

		expect(result.phase).toBe("auth");
		expect(result.status).toBe("verified");
		expect(result.nextAction.type).toBe("run_neon_init");
	});

	test("--verify continues flow when authenticated", async () => {
		mockIsAuthenticated.mockResolvedValue(true);

		const result = await handleAuthPhase({ verify: true });

		expect(result.status).toBe("verified");
		expect(result.nextAction.type).toBe("run_neon_init");
	});

	test("--verify returns not_authenticated when not authed", async () => {
		mockIsAuthenticated.mockResolvedValue(false);

		const result = await handleAuthPhase({ verify: true });

		expect(result.status).toBe("not_authenticated");
		expect(result.nextAction.type).toBe("run_neon_init");
	});

	test("--method existing returns run_command for OAuth", async () => {
		mockIsAuthenticated.mockResolvedValue(false);

		const result = await handleAuthPhase({ method: "existing" });

		expect(result.status).toBe("in_progress");
		expect(result.nextAction.type).toBe("run_command");
		if (result.nextAction.type === "run_command") {
			expect(result.nextAction.command).toContain("neonctl auth");
			expect(result.nextAction.timeout).toBe(120000);
			expect(result.nextAction.onFailure).toHaveProperty("2");
		}
	});

	test("--method new returns agent_action to open signup", async () => {
		mockIsAuthenticated.mockResolvedValue(false);

		const result = await handleAuthPhase({ method: "new" });

		expect(result.status).toBe("in_progress");
		expect(result.nextAction.type).toBe("agent_action");
		if (result.nextAction.type === "agent_action") {
			expect(result.nextAction.steps).toHaveLength(2);
			expect(result.nextAction.steps[0].id).toBe("open_signup");
			expect(result.nextAction.onComplete.type).toBe("run_neon_init");
		}
	});

	test("includes agent in args when provided", async () => {
		mockIsAuthenticated.mockResolvedValue(true);

		const result = await handleAuthPhase({
			agent: "claude",
			verify: true,
		});

		if (result.nextAction.type === "run_neon_init") {
			expect(result.nextAction.args).toContain("--agent");
			expect(result.nextAction.args).toContain("claude");
		}
	});
});
