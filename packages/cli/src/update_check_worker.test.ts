import { describe, expect, it } from "vitest";
import { npmViewInvocation } from "./update_check_worker.js";

describe("npmViewInvocation", () => {
	it("launches the Windows command shim through a shell", () => {
		expect(npmViewInvocation("win32")).toEqual({
			args: ["view", "neon", "version", "--json"],
			command: "npm.cmd",
			shell: true,
		});
	});

	it("launches npm directly on POSIX systems", () => {
		expect(npmViewInvocation("darwin")).toEqual({
			args: ["view", "neon", "version", "--json"],
			command: "npm",
			shell: false,
		});
	});
});
