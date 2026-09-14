import { describe, expect, test } from "vitest";
import {
	customDomainValidationError,
	normalizeCustomDomain,
} from "./custom-domain.js";

describe("normalizeCustomDomain", () => {
	test("trims, lowercases, and strips a trailing root dot", () => {
		expect(normalizeCustomDomain("  Docs.Example.COM. ")).toBe(
			"docs.example.com",
		);
	});
});

describe("customDomainValidationError", () => {
	test("accepts a DNS hostname", () => {
		expect(customDomainValidationError("docs.example.com")).toBeUndefined();
	});

	test("rejects empty after normalizing", () => {
		expect(customDomainValidationError(" . ")).toMatch(/empty/);
	});

	test("rejects a name that is not a DNS hostname", () => {
		expect(customDomainValidationError("not a host")).toMatch(
			/not a DNS hostname/,
		);
		expect(customDomainValidationError("localhost")).toMatch(
			/not a DNS hostname/,
		);
	});

	test("accepts a punycode TLD", () => {
		expect(
			customDomainValidationError("api.xn--e1afmkfd.xn--p1ai"),
		).toBeUndefined();
	});
});
