import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, vi } from "vitest";

const pickBranchInteractively = vi.hoisted(() => vi.fn());

vi.mock("../utils/branch_picker.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../utils/branch_picker.js")>();
	return {
		...original,
		pickBranchInteractively,
	};
});

import { getApiClient } from "../api.js";
import { test as originalTest } from "../test_utils/fixtures";
import { branchIdResolve } from "../utils/enrichers.js";
import { runLink } from "./link.js";

const TEST_TMP = mkdtempSync(join(tmpdir(), "neonctl-link-create-"));

const test = originalTest.extend<{
	tmpContext: (label: string) => string;
}>({
	tmpContext: async ({}, use) => {
		await use((label) => {
			const dir = join(TEST_TMP, label);
			mkdirSync(dir, { recursive: true });
			return join(dir, ".neon");
		});
	},
});

describe("link interactive branch create", () => {
	const originalStdinIsTTY = process.stdin.isTTY;
	const originalStdoutIsTTY = process.stdout.isTTY;

	afterEach(() => {
		vi.unstubAllEnvs();
		pickBranchInteractively.mockReset();
		process.stdin.isTTY = originalStdinIsTTY;
		process.stdout.isTTY = originalStdoutIsTTY;
	});

	test("persists the real id when the created name looks like a branch id", async ({
		runMockServer,
		tmpContext,
	}) => {
		vi.stubEnv("CI", "false");
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		pickBranchInteractively.mockResolvedValue({
			kind: "create",
			name: "br-feature-test-123456",
		});

		const server = await runMockServer("main");
		const apiHost = `http://localhost:${(server.address() as AddressInfo).port}`;
		const apiClient = getApiClient({
			apiKey: "test-key",
			apiHost,
		});
		const ctx = tmpContext("create_id_shaped");

		await runLink({
			apiClient,
			apiKey: "test-key",
			apiHost,
			output: "yaml",
			contextFile: ctx,
			projectId: "test",
			yes: false,
			clear: false,
			checks: true,
			envPull: false,
			config: false,
			cwd: join(ctx, ".."),
		});

		expect(pickBranchInteractively).toHaveBeenCalled();
		const pin: unknown = JSON.parse(readFileSync(ctx, "utf-8"));
		expect(pin).toEqual({
			projectId: "test",
			branch: "br-actual-created-654321",
		});
		if (
			typeof pin !== "object" ||
			pin === null ||
			!("projectId" in pin) ||
			!("branch" in pin) ||
			typeof pin.projectId !== "string" ||
			typeof pin.branch !== "string"
		) {
			throw new Error("expected .neon to contain projectId and branch");
		}

		const resolved = await branchIdResolve({
			branch: pin.branch,
			apiClient,
			projectId: pin.projectId,
		});
		expect(resolved).toBe("br-actual-created-654321");
		const fetched = await apiClient.getProjectBranch(
			pin.projectId,
			resolved,
		);
		expect(fetched.data.branch.id).toBe("br-actual-created-654321");
		expect(fetched.data.branch.name).toBe("br-feature-test-123456");
	});
});
