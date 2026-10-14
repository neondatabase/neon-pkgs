import { BETTER_AUTH_VERSION } from "@neon/auth";
import { getClientInfo } from "@neon/postgrest-js";
import { describe, expect, test } from "vitest";
import { buildNeonJsClientInfo } from "./client-info";

// Mirrors the Neon Auth server's SDK classification
// (neon-cloud/neon-auth/src/api/auth/legacy-shim.ts): "modern" only for
// better-auth >= 1.7, parsed with /^(\d+)\.(\d+)/.
function isModernBetterAuth(version: unknown): boolean {
	if (typeof version !== "string") return false;
	const m = /^(\d+)\.(\d+)/.exec(version);
	if (!m) return false;
	const major = Number(m[1]);
	const minor = Number(m[2]);
	return major > 1 || (major === 1 && minor >= 7);
}

describe("buildNeonJsClientInfo", () => {
	test("identifies neon-js and carries a bare, modern better-auth version", () => {
		const info = JSON.parse(buildNeonJsClientInfo());

		expect(info.sdk).toBe("@neon/neon-js");
		expect(info.betterAuthVersion).toBe(BETTER_AUTH_VERSION);
		expect(info.betterAuthVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(isModernBetterAuth(info.betterAuthVersion)).toBe(true);
	});
});

describe("postgrest-js getClientInfo", () => {
	test("does not emit betterAuthVersion", () => {
		const info = getClientInfo("@neon/postgrest-js", "0.0.0");
		expect("betterAuthVersion" in info).toBe(false);
	});
});
