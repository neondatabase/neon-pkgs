import { createNeonApiFromOptions } from "@neondatabase/config";
import { describe, expect, test, vi } from "vitest";
import { apply, inspect, plan } from "./operations.js";
import { pullConfig } from "./pull-config.js";
import { pushConfig } from "./push-config.js";

const HOST = "https://stage.example/api/v2";

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

describe("pullConfig — apiHost forwarding", () => {
	test("forwards apiHost (and apiKey) to createNeonApiFromOptions", async () => {
		await expect(
			pullConfig({
				projectId: "p",
				branchId: "br-1",
				apiKey: "napi_k",
				apiHost: HOST,
			}),
		).rejects.toThrow("STOP-AFTER-API-BUILD");
		expect(createNeonApiFromOptions).toHaveBeenCalledWith("pullConfig", {
			apiKey: "napi_k",
			apiHost: HOST,
		});
	});
});

describe("pushConfig — apiHost forwarding", () => {
	test("forwards apiHost (and apiKey) to createNeonApiFromOptions", async () => {
		await expect(
			pushConfig({} as never, {
				projectId: "p",
				branchId: "br-1",
				apiKey: "napi_k",
				apiHost: HOST,
			}),
		).rejects.toThrow("STOP-AFTER-API-BUILD");
		expect(createNeonApiFromOptions).toHaveBeenCalledWith("pushConfig", {
			apiKey: "napi_k",
			apiHost: HOST,
		});
	});
});

describe("operations — apiHost forwarding", () => {
	test("inspect forwards apiHost down to pullConfig", async () => {
		await expect(
			inspect({
				projectId: "p",
				branchId: "br-1",
				apiKey: "k",
				apiHost: HOST,
			}),
		).rejects.toThrow("STOP-AFTER-API-BUILD");
		expect(createNeonApiFromOptions).toHaveBeenCalledWith("pullConfig", {
			apiKey: "k",
			apiHost: HOST,
		});
	});

	test("plan forwards apiHost down to pushConfig", async () => {
		await expect(
			plan({} as never, {
				projectId: "p",
				branchId: "br-1",
				apiKey: "k",
				apiHost: HOST,
			}),
		).rejects.toThrow("STOP-AFTER-API-BUILD");
		expect(createNeonApiFromOptions).toHaveBeenCalledWith("pushConfig", {
			apiKey: "k",
			apiHost: HOST,
		});
	});

	test("apply forwards apiHost down to pushConfig", async () => {
		await expect(
			apply({} as never, {
				projectId: "p",
				branchId: "br-1",
				apiKey: "k",
				apiHost: HOST,
			}),
		).rejects.toThrow("STOP-AFTER-API-BUILD");
		expect(createNeonApiFromOptions).toHaveBeenCalledWith("pushConfig", {
			apiKey: "k",
			apiHost: HOST,
		});
	});
});
