import { beforeEach, describe, expect, it, vi } from "vitest";
import { functionHostname } from "../index.js";

beforeEach(() => {
	vi.stubEnv("NEON_BRANCH_ID", "br-calm-river-a1b2c3");
	vi.stubEnv(
		"NEON_FUNCTION_HOST_SUFFIX",
		".compute.c-3.us-east-2.aws.neon.tech",
	);
	vi.stubEnv("NEON_DEV_FUNCTION_PORTS", undefined);
});

describe("functionHostname", () => {
	it("constructs a sibling host from the serving branch and leading-dot suffix", () => {
		expect(functionHostname("hello")).toBe(
			"br-calm-river-a1b2c3-hello.compute.c-3.us-east-2.aws.neon.tech",
		);
	});

	it("preserves an invocation port and reads the env at call time", () => {
		functionHostname("hello");
		vi.stubEnv("NEON_FUNCTION_HOST_SUFFIX", ".compute.example.com:8443");
		expect(functionHostname("hello")).toBe(
			"br-calm-river-a1b2c3-hello.compute.example.com:8443",
		);
	});

	it("uses the local port map without requiring a linked branch", () => {
		vi.stubEnv("NEON_DEV_FUNCTION_PORTS", '{"hello":8787,"world":8788}');
		vi.stubEnv("NEON_BRANCH_ID", undefined);
		vi.stubEnv("NEON_FUNCTION_HOST_SUFFIX", undefined);
		expect(functionHostname("hello")).toBe("localhost:8787");
		expect(functionHostname("world")).toBe("localhost:8788");
	});

	it("uses the deployed hostname for a sibling not served by neon dev --source", () => {
		vi.stubEnv("NEON_DEV_FUNCTION_PORTS", '{"world":8788}');
		expect(functionHostname("hello")).toBe(
			"br-calm-river-a1b2c3-hello.compute.c-3.us-east-2.aws.neon.tech",
		);
	});

	it.each([
		"",
		"HELLO",
		"hello-world",
		"hello/path",
		"a".repeat(21),
	])("rejects an invalid slug: %j", (slug) =>
		expect(() => functionHostname(slug)).toThrow(/slug must match/));

	it.each([
		"NEON_BRANCH_ID",
		"NEON_FUNCTION_HOST_SUFFIX",
	])("names the setup needed when %s is absent", (key) => {
		vi.stubEnv(key, undefined);
		expect(() => functionHostname("hello")).toThrow(/neon env pull/);
	});

	it.each([
		"br.with.dots",
		"br_underscore",
		"b".repeat(58),
	])("rejects a branch and slug that cannot form one DNS label: %s", (branchId) => {
		vi.stubEnv("NEON_BRANCH_ID", branchId);
		expect(() => functionHostname("hello")).toThrow(
			/valid function hostname/,
		);
	});

	it.each([
		"compute.example.com",
		".compute.example.com/path",
		".compute.example.com:65536",
	])("rejects a malformed suffix: %s", (suffix) => {
		vi.stubEnv("NEON_FUNCTION_HOST_SUFFIX", suffix);
		expect(() => functionHostname("hello")).toThrow(
			/valid function hostname/,
		);
	});

	it.each([
		"",
		"not JSON",
		"null",
		"[]",
		'{"hello":0}',
		'{"hello":65536}',
		'{"hello":"8787"}',
	])("reports an invalid local port map: %j", (ports) => {
		vi.stubEnv("NEON_DEV_FUNCTION_PORTS", ports);
		expect(() => functionHostname("hello")).toThrow(
			/invalid local function ports/,
		);
	});
});
