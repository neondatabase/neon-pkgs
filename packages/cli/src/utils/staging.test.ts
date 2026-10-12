import { describe, expect, test } from "vitest";
import { isStagingApiHost, STAGING_API_HOST } from "./staging.js";

describe("isStagingApiHost", () => {
	test.each([
		[STAGING_API_HOST, true],
		["https://console-stage.neon.build", true],
		["https://console.neon.tech/api/v2", false],
		["https://console-stage.neon.build.example.com/api/v2", false],
		["http://localhost:8080", false],
		["not a url", false],
		[undefined, false],
	])("%s -> %s", (apiHost, expected) => {
		expect(isStagingApiHost(apiHost)).toBe(expected);
	});
});
