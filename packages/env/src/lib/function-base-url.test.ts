import { ErrorCode } from "@neon/config/v1";
import { describe, expect, test } from "vitest";
import { functionBaseUrl } from "./function-base-url.js";

const deployed = {
	NEON_BRANCH_ID: "br-lingering-lab-bcm0swdb",
	NEON_FUNCTION_HOST_SUFFIX: ".compute.c-16.us-east-1.aws.neon.tech",
};

describe("functionBaseUrl", () => {
	test("builds the deployed hostname from the branch id and suffix", () => {
		expect(functionBaseUrl("hello", deployed)).toBe(
			"https://br-lingering-lab-bcm0swdb-hello.compute.c-16.us-east-1.aws.neon.tech",
		);
	});

	test("prefers the localhost port neon dev serves the function on", () => {
		const env = {
			...deployed,
			NEON_DEV_FUNCTION_PORTS: JSON.stringify({ hello: 8787 }),
		};
		expect(functionBaseUrl("hello", env)).toBe("http://localhost:8787");
		// A function neon dev does not serve still resolves to the branch.
		expect(functionBaseUrl("world", env)).toBe(
			"https://br-lingering-lab-bcm0swdb-world.compute.c-16.us-east-1.aws.neon.tech",
		);
	});

	test("reads process.env by default", () => {
		const saved = { ...process.env };
		try {
			Object.assign(process.env, deployed);
			delete process.env.NEON_DEV_FUNCTION_PORTS;
			expect(functionBaseUrl("hello")).toBe(
				"https://br-lingering-lab-bcm0swdb-hello.compute.c-16.us-east-1.aws.neon.tech",
			);
		} finally {
			process.env = saved;
		}
	});

	test.each([
		"",
		"Hello",
		"hello-world",
		"a".repeat(21),
		"../x",
	])("rejects the slug %j", (slug) => {
		expect(() => functionBaseUrl(slug, deployed)).toThrow(TypeError);
	});

	test("names every missing variable", () => {
		expect(() => functionBaseUrl("hello", {})).toThrow(
			expect.objectContaining({
				code: ErrorCode.EnvNotInjected,
				message: expect.stringContaining(
					"NEON_BRANCH_ID and NEON_FUNCTION_HOST_SUFFIX are not set",
				),
			}),
		);
		expect(() =>
			functionBaseUrl("hello", {
				NEON_BRANCH_ID: deployed.NEON_BRANCH_ID,
			}),
		).toThrow(/NEON_FUNCTION_HOST_SUFFIX is not set/);
	});

	test.each([
		[
			"a suffix without the leading dot",
			{ NEON_FUNCTION_HOST_SUFFIX: "compute.neon.tech" },
		],
		[
			"a suffix with a path",
			{ NEON_FUNCTION_HOST_SUFFIX: ".compute.neon.tech/x" },
		],
		[
			"a suffix with a port",
			{ NEON_FUNCTION_HOST_SUFFIX: ".compute.neon.tech:443" },
		],
		[
			"a suffix with userinfo",
			{ NEON_FUNCTION_HOST_SUFFIX: ".x@evil.example" },
		],
		[
			"an empty label",
			{ NEON_FUNCTION_HOST_SUFFIX: ".compute..neon.tech" },
		],
		[
			"a trailing dot",
			{ NEON_FUNCTION_HOST_SUFFIX: ".compute.neon.tech." },
		],
		["a branch id with a dot", { NEON_BRANCH_ID: "br-a.evil" }],
		["a branch id with a path", { NEON_BRANCH_ID: "evil.example/x?" }],
		[
			"a branch id with an authority",
			{ NEON_BRANCH_ID: "x@evil.example#" },
		],
	])("rejects %s", (_name, override) => {
		expect(() =>
			functionBaseUrl("hello", { ...deployed, ...override }),
		).toThrow(
			expect.objectContaining({
				code: ErrorCode.EnvNotInjected,
				message: expect.stringContaining(
					"do not form a function hostname",
				),
			}),
		);
	});

	test.each([
		"not json",
		"[8787]",
		"null",
		JSON.stringify({ hello: "8787" }),
		JSON.stringify({ hello: 0 }),
		JSON.stringify({ hello: 65536 }),
		JSON.stringify({ hello: 80.5 }),
	])("rejects NEON_DEV_FUNCTION_PORTS=%s", (ports) => {
		expect(() =>
			functionBaseUrl("hello", {
				...deployed,
				NEON_DEV_FUNCTION_PORTS: ports,
			}),
		).toThrow(/restart `neon dev`/);
	});
});
