import { createNeonApiFromOptions } from "@neondatabase/config/v1";
import { describe, expect, test, vi } from "vitest";
import { fetchEnv } from "./env.js";

// Throw immediately after the API client would be built: fetchEnv builds its API before
// any other work, so this asserts the forwarded options without any network.
vi.mock("@neondatabase/config/v1", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@neondatabase/config/v1")>();
	return {
		...actual,
		createNeonApiFromOptions: vi.fn(() => {
			throw new Error("STOP-AFTER-API-BUILD");
		}),
	};
});

describe("fetchEnv — apiHost forwarding", () => {
	test("forwards apiHost (and apiKey) to createNeonApiFromOptions", async () => {
		await expect(
			fetchEnv({} as never, {
				projectId: "p",
				branchId: "br-1",
				apiKey: "napi_k",
				apiHost: "https://stage.example/api/v2",
			}),
		).rejects.toThrow("STOP-AFTER-API-BUILD");
		expect(createNeonApiFromOptions).toHaveBeenCalledWith("fetchEnv", {
			apiKey: "napi_k",
			apiHost: "https://stage.example/api/v2",
		});
	});
});
