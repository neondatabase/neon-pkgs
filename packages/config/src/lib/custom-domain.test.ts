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

	test("accepts a 253-character hostname, including a trailing root dot", () => {
		const hostname = hostnameOfLength(253);
		expect(customDomainValidationError(hostname)).toBeUndefined();
		expect(customDomainValidationError(`${hostname}.`)).toBeUndefined();
	});

	test("rejects a 254-character normalized hostname", () => {
		expect(customDomainValidationError(hostnameOfLength(254))).toMatch(
			/3–253 characters after normalizing/,
		);
	});
});

/** DNS labels of at most 63 characters so length is the only variable. */
function hostnameOfLength(length: number): string {
	const labels: string[] = [];
	let remaining = length;
	while (remaining > 64) {
		labels.push("a".repeat(63));
		remaining -= 64;
	}
	labels.push("a".repeat(remaining));
	return labels.join(".");
}
