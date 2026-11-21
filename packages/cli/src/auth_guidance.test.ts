import { describe, expect, it } from "vitest";
import { signInGuidance } from "./auth_context.js";
import { isAgentContext } from "./env.js";

describe("isAgentContext", () => {
	it("is false for a person at a terminal", () => {
		expect(isAgentContext({}, true)).toBe(false);
	});

	it("is true for a detected coding agent, even with a terminal", () => {
		expect(isAgentContext({ CURSOR_AGENT: "1" }, true)).toBe(true);
	});

	it("is true when no stdio stream has a terminal", () => {
		expect(isAgentContext({}, false)).toBe(true);
	});
});

describe("signInGuidance", () => {
	it("lists sign-in, a saved key, and Claimable Neon when nothing was stored and the directory isn't linked", () => {
		expect(
			signInGuidance({
				cli: "neon",
				profile: "DEFAULT",
				explicitProfile: false,
				offerClaimable: true,
				ci: false,
			}),
		).toBe(
			[
				"Sign in with a browser on this machine: `neon login`",
				'Or save an API key you already have: `echo "$KEY" | neon profile create DEFAULT --api-key -`',
				"Or create a temporary project without an account: `neon claim create` (it expires in 72 hours unless claimed)",
			].join("\n"),
		);
	});

	it("leaves out Claimable Neon for a linked directory or an expired session", () => {
		expect(
			signInGuidance({
				cli: "neon",
				profile: "DEFAULT",
				explicitProfile: false,
				offerClaimable: false,
				ci: false,
			}),
		).not.toContain("claim create");
	});

	it("names an explicitly selected profile in every command", () => {
		const text = signInGuidance({
			cli: "neon",
			profile: "work",
			explicitProfile: true,
			offerClaimable: false,
			ci: false,
		});
		expect(text).toContain("`neon login --profile work`");
		expect(text).toContain("neon profile create work --api-key -");
	});

	it("points CI at NEON_API_KEY, where browser sign-in is refused", () => {
		expect(
			signInGuidance({
				cli: "neon",
				profile: "DEFAULT",
				explicitProfile: false,
				offerClaimable: true,
				ci: true,
			}),
		).toBe(
			[
				"Set NEON_API_KEY to an API key.",
				"Or create a temporary project without an account: `neon claim create` (it expires in 72 hours unless claimed)",
			].join("\n"),
		);
	});

	it("saves the key on a selected profile in CI, where NEON_API_KEY would not apply", () => {
		expect(
			signInGuidance({
				cli: "neon",
				profile: "work",
				explicitProfile: true,
				offerClaimable: false,
				ci: true,
			}),
		).toBe(
			'Save an API key to this profile: `echo "$KEY" | neon profile create work --api-key -`',
		);
	});
});
