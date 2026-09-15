import { describe, expect, test } from "vitest";
import {
	ConfigValidationError,
	isPlatformError,
	PushConflictError,
} from "./errors.js";

describe("ConfigValidationError", () => {
	test("formats issues", () => {
		const err = new ConfigValidationError(["ttl: invalid duration"]);
		expect(err.message).toContain("ttl: invalid duration");
	});
});

describe("isPlatformError", () => {
	test("recognises a real PlatformError instance", () => {
		expect(isPlatformError(new ConfigValidationError(["x"]))).toBe(true);
	});

	test("recognises a cross-realm clone by its PLATFORM_ code", () => {
		// A `neon.ts` loaded via jiti throws a PlatformError from a *different* copy of
		// this module, so `instanceof` fails; the structural `code` check must still pass.
		const crossRealm = {
			name: "ConfigValidationError",
			code: "PLATFORM_INVALID_CONFIG",
			message: "bad",
		};
		expect(isPlatformError(crossRealm)).toBe(true);
	});

	test("rejects ordinary errors and non-platform codes", () => {
		expect(isPlatformError(new Error("boom"))).toBe(false);
		expect(isPlatformError({ code: "ENOENT", message: "nope" })).toBe(
			false,
		);
		expect(isPlatformError("PLATFORM_INVALID_CONFIG")).toBe(false);
		expect(isPlatformError(null)).toBe(false);
		expect(isPlatformError(undefined)).toBe(false);
	});
});

describe("PushConflictError", () => {
	test("formats branch conflicts with updateExisting hint", () => {
		const err = new PushConflictError([
			{
				kind: "branch",
				identifier: "main",
				field: "protected",
				current: false,
				desired: true,
				reason: "different protected flag",
			},
		]);
		expect(err.message).toContain("[branch:main] protected");
		expect(err.message).toContain("--update-existing");
	});

	test("unknown custom-domain entity types do not suggest --update-existing", () => {
		const err = new PushConflictError([
			{
				kind: "branch",
				identifier: "main",
				field: "customDomain",
				current: { entityType: "bucket", entityId: "uploads" },
				desired: { entityType: "function", entityId: "hello" },
				reason: 'custom domain "docs.example.com" is registered to entity type "bucket", which neon.ts cannot retarget. Delete it with `neon function domains delete` or stop declaring it.',
			},
		]);
		expect(err.message).toContain("customDomain");
		expect(err.message).not.toContain("--update-existing");
		expect(err.message).not.toContain("updateExisting");
	});

	test("a hostname containing updateexisting stays a blocking conflict", () => {
		const err = new PushConflictError([
			{
				kind: "branch",
				identifier: "main",
				field: "customDomain",
				current: { entityType: "bucket", entityId: "uploads" },
				desired: { entityType: "function", entityId: "hello" },
				reason: 'custom domain "updateexisting.example.com" is registered to entity type "bucket", which neon.ts cannot retarget. Delete it with `neon function domains delete` or stop declaring it.',
			},
		]);
		expect(err.message).not.toContain(
			"For mutable conflicts, pass `updateExisting: true`",
		);
		expect(err.message).toContain(
			"delete the domain with `neon function domains delete`",
		);
	});
});
