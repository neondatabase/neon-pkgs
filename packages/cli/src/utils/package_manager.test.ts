import { describe, expect, test } from "vitest";

import { commandEnv } from "./package_manager.js";

describe("commandEnv", () => {
	test("strips an inherited NEON_API_KEY from npm and git children", () => {
		expect(
			commandEnv(undefined, { PATH: "/bin", NEON_API_KEY: "napi_env" }),
		).toEqual({ PATH: "/bin" });
	});

	test("strips mixed-case inherited keys", () => {
		expect(
			commandEnv(undefined, { PATH: "/bin", neon_api_key: "napi_mixed" }),
		).toEqual({ PATH: "/bin" });
	});

	test("keeps an explicit overlay key", () => {
		expect(
			commandEnv(
				{ NEON_API_KEY: "napi_flag" },
				{ PATH: "/bin", NEON_API_KEY: "napi_env" },
			),
		).toEqual({ PATH: "/bin", NEON_API_KEY: "napi_flag" });
	});
});
