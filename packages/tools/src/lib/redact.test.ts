import { describe, expect, test } from "vitest";
import { REDACTED_SECRET, redactSecretFields } from "./redact.js";

describe("redactSecretFields", () => {
	test("redacts the whole value at $", () => {
		expect(redactSecretFields("postgresql://u:p@h/db", ["$"])).toBe(
			REDACTED_SECRET,
		);
	});

	test("redacts nested fields and every item of an array", () => {
		const data = {
			oauth_providers: [
				{ id: "google", type: "shared" },
				{ id: "github", client_id: "gh", client_secret: "cs" },
			],
			email_provider: { type: "standard", password: "pw", host: "smtp" },
		};

		expect(
			redactSecretFields(data, [
				"$.oauth_providers[*].client_secret",
				"$.email_provider.password",
			]),
		).toEqual({
			oauth_providers: [
				{ id: "google", type: "shared" },
				{
					id: "github",
					client_id: "gh",
					client_secret: REDACTED_SECRET,
				},
			],
			email_provider: {
				type: "standard",
				password: REDACTED_SECRET,
				host: "smtp",
			},
		});
		expect(data.email_provider.password).toBe("pw");
	});

	test("redacts every item of a root array", () => {
		expect(
			redactSecretFields(
				[{ name: "a", password: "x" }, { name: "b" }],
				["$[*].password"],
			),
		).toEqual([{ name: "a", password: REDACTED_SECRET }, { name: "b" }]);
	});

	test("leaves absent, null, and empty values as they are", () => {
		expect(
			redactSecretFields({ a: null, b: "", nested: null }, [
				"$.a",
				"$.b",
				"$.c",
				"$.nested.password",
			]),
		).toEqual({ a: null, b: "", nested: null });
	});

	test("throws when a secret path meets a different shape", () => {
		expect(() =>
			redactSecretFields({ password: 1 }, ["$.password"]),
		).toThrow("Secret at $.password is not a string");
		expect(() =>
			redactSecretFields({ roles: {} }, ["$.roles[*].password"]),
		).toThrow("Secret path $.roles[*].password expects an array");
		expect(() => redactSecretFields("value", ["$.password"])).toThrow(
			"Secret path $.password expects an object",
		);
	});

	test("rejects a path outside $, .key, and [*]", () => {
		expect(() => redactSecretFields({}, ["password"])).toThrow(
			"Secret path must start with $: password",
		);
		expect(() => redactSecretFields({}, ["$.roles[0]"])).toThrow(
			"Unsupported secret path: $.roles[0]",
		);
	});
});
