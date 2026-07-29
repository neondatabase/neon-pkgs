import { afterEach, describe, expect, it } from "vitest";

import { getCliName } from "./cli_name.js";

describe("getCliName", () => {
	const originalArgv1 = process.argv[1];

	afterEach(() => {
		process.argv[1] = originalArgv1;
	});

	it("returns 'neonctl' only when invoked literally as neonctl", () => {
		process.argv[1] = "/usr/local/bin/neonctl";
		expect(getCliName()).toBe("neonctl");
	});

	it("returns 'neon' when invoked as neon", () => {
		process.argv[1] = "/usr/local/bin/neon";
		expect(getCliName()).toBe("neon");
	});

	it("returns 'neon' for any other invocation name (e.g. index.js in tests)", () => {
		process.argv[1] = "/repo/packages/cli/dist/index.js";
		expect(getCliName()).toBe("neon");
	});

	it("returns 'neon' for an arbitrary renamed binary (does not echo)", () => {
		process.argv[1] = "/opt/tools/HelloWorld";
		expect(getCliName()).toBe("neon");
	});

	it("applies basename, not a raw path compare", () => {
		process.argv[1] = "/some/deep/path/to/neonctl";
		expect(getCliName()).toBe("neonctl");
	});

	it("does not throw when argv[1] is undefined", () => {
		// @ts-expect-error deliberately clearing to exercise the `?? ""` guard
		process.argv[1] = undefined;
		expect(getCliName()).toBe("neon");
	});
});
