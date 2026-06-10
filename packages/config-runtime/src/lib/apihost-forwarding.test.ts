import { createNeonApiFromOptions } from "@neondatabase/config";
import { afterEach, describe, expect, test, vi } from "vitest";
import { pullConfig } from "./pull-config.js";

// Throw immediately after the API client would be built. Every runtime entry builds its
// API as its first statement, so this asserts the forwarded options without any network.
vi.mock("@neondatabase/config", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@neondatabase/config")>();
	return {
		...actual,
		createNeonApiFromOptions: vi.fn(() => {
			throw new Error("STOP-AFTER-API-BUILD");
		}),
	};
});

afterEach(() => vi.clearAllMocks());

describe("pullConfig — apiHost forwarding", () => {
	test("forwards apiHost (and apiKey) to createNeonApiFromOptions", async () => {
		await expect(
			pullConfig({
				projectId: "p",
				branchId: "br-1",
				apiKey: "napi_k",
				apiHost: "https://stage.example/api/v2",
			}),
		).rejects.toThrow("STOP-AFTER-API-BUILD");
		expect(createNeonApiFromOptions).toHaveBeenCalledWith("pullConfig", {
			apiKey: "napi_k",
			apiHost: "https://stage.example/api/v2",
		});
	});
});
