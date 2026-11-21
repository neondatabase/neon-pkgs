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
	it("offers Claimable Neon when nothing was stored and the directory isn't linked", () => {
		expect(
			signInGuidance({
				cli: "neon",
				profile: "DEFAULT",
				explicitProfile: false,
				offerClaimable: true,
				browser: true,
			}),
		).toBe(
			"If someone can complete a browser sign-in that reaches this machine's 127.0.0.1 callback, run `neon login --profile DEFAULT`. If no one can, set an API key the user already has as NEON_API_KEY, or create a separate temporary project without an account with `neon claim create` (it expires in 72 hours unless claimed). Do not ask the user to create an API key.",
		);
	});

	it("stops instead of offering a new project for a linked directory or an expired session", () => {
		const text = signInGuidance({
			cli: "neon",
			profile: "DEFAULT",
			explicitProfile: false,
			offerClaimable: false,
			browser: true,
		});
		expect(text).not.toContain("claim create");
		expect(text).toContain(
			"If no one can, tell the user they need to sign in or to set an API key the user already has as NEON_API_KEY, and stop.",
		);
	});

	it("stores a key on an explicitly selected profile, where NEON_API_KEY would not apply", () => {
		const text = signInGuidance({
			cli: "neon",
			profile: "work",
			explicitProfile: true,
			offerClaimable: true,
			browser: true,
		});
		expect(text).toContain("run `neon login --profile work`");
		expect(text).toContain(
			"store an API key the user already has with `neon profile create work --api-key -`",
		);
		expect(text).not.toContain("NEON_API_KEY");
	});

	it("names only the alternatives where interactive sign-in is refused", () => {
		expect(
			signInGuidance({
				cli: "neon",
				profile: "DEFAULT",
				explicitProfile: false,
				offerClaimable: true,
				browser: false,
			}),
		).toBe(
			"Set an API key the user already has as NEON_API_KEY, or create a separate temporary project without an account with `neon claim create` (it expires in 72 hours unless claimed). Do not ask the user to create an API key.",
		);
	});
});
