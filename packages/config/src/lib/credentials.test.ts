import { describe, expect, test } from "vitest";
import {
	credentialScopesSatisfied,
	deriveCredentialScopes,
} from "./credentials.js";

describe("deriveCredentialScopes", () => {
	test("no enabled feature yields no scopes (mint nothing)", () => {
		expect(
			deriveCredentialScopes({
				storage: false,
				aiGateway: false,
				functions: false,
			}),
		).toEqual([]);
	});

	test("buckets grant read + write storage scopes", () => {
		expect(
			deriveCredentialScopes({
				storage: true,
				aiGateway: false,
				functions: false,
			}),
		).toEqual(["storage:read", "storage:write"]);
	});

	test("AI Gateway grants invoke", () => {
		expect(
			deriveCredentialScopes({
				storage: false,
				aiGateway: true,
				functions: false,
			}),
		).toEqual(["ai_gateway:invoke"]);
	});

	test("functions grant invoke (rides along on the unified credential)", () => {
		expect(
			deriveCredentialScopes({
				storage: true,
				aiGateway: false,
				functions: true,
			}),
		).toEqual(["storage:read", "storage:write", "functions:invoke"]);
	});

	test("all features produce a deterministic, order-stable scope set", () => {
		expect(
			deriveCredentialScopes({
				storage: true,
				aiGateway: true,
				functions: true,
			}),
		).toEqual([
			"storage:read",
			"storage:write",
			"ai_gateway:invoke",
			"functions:invoke",
		]);
	});
});

describe("credentialScopesSatisfied", () => {
	test("a superset credential satisfies a narrower desired set", () => {
		expect(
			credentialScopesSatisfied(
				["storage:read", "storage:write", "ai_gateway:invoke"],
				["storage:read", "storage:write"],
			),
		).toBe(true);
	});

	test("an equal set is satisfied", () => {
		expect(
			credentialScopesSatisfied(
				["storage:read", "storage:write"],
				["storage:read", "storage:write"],
			),
		).toBe(true);
	});

	test("a missing scope is not satisfied (must re-mint)", () => {
		expect(
			credentialScopesSatisfied(
				["storage:read", "storage:write"],
				["storage:read", "storage:write", "ai_gateway:invoke"],
			),
		).toBe(false);
	});

	test("an empty desired set is always satisfied", () => {
		expect(credentialScopesSatisfied([], [])).toBe(true);
		expect(credentialScopesSatisfied(["storage:read"], [])).toBe(true);
	});
});
