import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prompts from "prompts";
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

describe("link result", () => {
	const props = (apiHost: string, contextFile: string) => ({
		apiClient: getApiClient({ apiKey: "test-key", apiHost }),
		apiKey: "test-key",
		apiHost,
		output: "yaml" as const,
		contextFile,
		yes: true,
		clear: false,
		checks: true,
		envPull: false,
		config: false,
		cwd: join(contextFile, ".."),
	});

	test("an existing project reports created: false", async ({
		runMockServer,
		tmpContext,
	}) => {
		const server = await runMockServer("main");
		const apiHost = `http://localhost:${(server.address() as AddressInfo).port}`;
		const ctx = tmpContext("result_existing");

		await expect(
			runLink({ ...props(apiHost, ctx), projectId: "test" }),
		).resolves.toEqual({ created: false });
		await expect(
			runLink({ ...props(apiHost, ctx), branch: "main" }),
		).resolves.toEqual({ created: false });
	});

	test("a created project reports created: true", async ({
		runMockServer,
		tmpContext,
	}) => {
		const server = await runMockServer("main");
		const apiHost = `http://localhost:${(server.address() as AddressInfo).port}`;

		await expect(
			runLink({
				...props(apiHost, tmpContext("result_created")),
				orgId: "org-2",
				projectName: "test_project",
				regionId: "aws-us-east-2",
			}),
		).resolves.toEqual({ created: true });
	});

	test("an existing project picked interactively reports created: false", async ({
		runMockServer,
		tmpContext,
	}) => {
		vi.stubEnv("CI", "false");
		const stdinIsTTY = process.stdin.isTTY;
		const stdoutIsTTY = process.stdout.isTTY;
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		prompts.inject(["test"]);
		pickBranchInteractively.mockResolvedValue({
			kind: "existing",
			branchId: "br-main-branch-123456",
		});
		const server = await runMockServer("main");
		const apiHost = `http://localhost:${(server.address() as AddressInfo).port}`;

		try {
			await expect(
				runLink({
					...props(apiHost, tmpContext("result_picked")),
					yes: false,
					orgId: "org-2",
				}),
			).resolves.toEqual({ created: false });
			expect(pickBranchInteractively).toHaveBeenCalled();
		} finally {
			process.stdin.isTTY = stdinIsTTY;
			process.stdout.isTTY = stdoutIsTTY;
			vi.unstubAllEnvs();
			pickBranchInteractively.mockReset();
		}
	});

	test("--no-checks verifies nothing and reports no result", async ({
		tmpContext,
	}) => {
		await expect(
			runLink({
				...props("http://localhost:1", tmpContext("result_offline")),
				checks: false,
				orgId: "org-2",
				projectId: "test",
				branch: "main",
			}),
		).resolves.toBeUndefined();
	});
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

	test("no-default recovery keeps --config-dir and --profile", async ({
		runMockServer,
		tmpContext,
	}) => {
		const server = await runMockServer("main");
		const apiHost = `http://localhost:${(server.address() as AddressInfo).port}`;
		const apiClient = getApiClient({
			apiKey: "test-key",
			apiHost,
		});
		const ctx = tmpContext("session_profile");
		const configDir = join(ctx, "..", "auth");

		let message = "";
		try {
			await runLink({
				apiClient,
				apiKey: "test-key",
				apiHost,
				output: "json",
				contextFile: ctx,
				projectId: "proj-no-default",
				yes: true,
				clear: false,
				checks: true,
				envPull: false,
				config: false,
				cwd: join(ctx, ".."),
				profile: "review-ci",
				configDir,
			});
		} catch (err) {
			if (!(err instanceof Error)) {
				throw err;
			}
			message = err.message;
		}
		expect(message).toContain(
			"neon link -y --project-id proj-no-default --branch <name-or-id>",
		);
		expect(message).toContain(`--config-dir ${configDir}`);
		expect(message).toContain("--profile review-ci");
		expect(message).toContain(`--context-file ${ctx}`);
		expect(message).toContain("--output json");
		expect(message).toContain("--no-env-pull");
	});
});
