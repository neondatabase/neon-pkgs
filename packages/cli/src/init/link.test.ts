import { describe, expect, test, vi } from "vitest";
import { getApiClient, NeonApiError } from "../api.js";
import { runAuthenticatedLink } from "./link.js";

const props = () => ({
	apiClient: getApiClient({
		apiKey: "napi_test",
		apiHost: "https://console.neon.tech/api/v2",
	}),
	apiKey: "napi_test",
	apiHost: "https://console.neon.tech/api/v2",
	output: "table" as const,
	contextFile: "/tmp/app/.neon",
	yes: false,
	clear: false,
	checks: true,
	envPull: true,
	config: false,
	cwd: "/tmp/app",
});

describe("runAuthenticatedLink", () => {
	test("authenticates and runs only the shared link operation", async () => {
		const calls: string[] = [];
		const authenticate = vi.fn(async () => {
			calls.push("authenticate");
		});
		const link = vi.fn(async () => {
			calls.push("link");
		});
		const recover = vi.fn(async () => false);

		await runAuthenticatedLink(props(), { authenticate, link, recover });

		expect(calls).toEqual(["authenticate", "link"]);
		expect(recover).not.toHaveBeenCalled();
	});

	test("refreshes once and retries only link after a 401", async () => {
		const authenticate = vi.fn().mockResolvedValue(undefined);
		const link = vi
			.fn()
			.mockRejectedValueOnce(
				new NeonApiError("unauthorized", { status: 401 }),
			)
			.mockResolvedValueOnce(undefined);
		const recover = vi.fn().mockResolvedValue(true);

		await runAuthenticatedLink(props(), { authenticate, link, recover });

		expect(authenticate).toHaveBeenCalledTimes(2);
		expect(link).toHaveBeenCalledTimes(2);
		expect(recover).toHaveBeenCalledWith(true);
	});

	test("turns an unrecoverable 401 into a non-retryable command error", async () => {
		const authenticate = vi.fn().mockResolvedValue(undefined);
		const link = vi
			.fn()
			.mockRejectedValue(
				new NeonApiError("unauthorized", { status: 401 }),
			);
		const recover = vi.fn().mockResolvedValue(false);

		await expect(
			runAuthenticatedLink(props(), { authenticate, link, recover }),
		).rejects.toThrow("Authentication failed.");
		expect(link).toHaveBeenCalledTimes(1);
		expect(recover).toHaveBeenCalledWith(true);
	});
});
