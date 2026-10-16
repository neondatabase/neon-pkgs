import { describe, expect, it } from "vitest";

import { parseCookies, seal, serializeCookie, unseal } from "./cookies";

const SECRET = "a".repeat(32);
const payload = { accessToken: "at", user: { id: "u1" } };

describe("cookie sealing", () => {
	it("round-trips a payload", async () => {
		const value = await seal(payload, SECRET, "session", 60);
		expect(
			Buffer.from(value.split(".")[3], "base64url").toString(),
		).not.toContain("accessToken");
		expect(await unseal(value, SECRET, "session")).toEqual(payload);
	});

	it("rejects a tampered cookie", async () => {
		const value = await seal(payload, SECRET, "session", 60);
		const parts = value.split(".");
		const ct = Buffer.from(parts[3], "base64url");
		ct[0] ^= 1;
		parts[3] = ct.toString("base64url");
		expect(
			await unseal(parts.join("."), SECRET, "session"),
		).toBeUndefined();
	});

	it("rejects a different secret", async () => {
		const value = await seal(payload, SECRET, "session", 60);
		expect(await unseal(value, "b".repeat(32), "session")).toBeUndefined();
	});

	it("rejects a cookie sealed for another purpose", async () => {
		const value = await seal(payload, SECRET, "tx", 60);
		expect(await unseal(value, SECRET, "session")).toBeUndefined();
	});

	it("rejects an expired cookie", async () => {
		const value = await seal(payload, SECRET, "session", 1);
		await new Promise((r) => setTimeout(r, 2100));
		expect(await unseal(value, SECRET, "session")).toBeUndefined();
	});

	it("refuses a short secret", async () => {
		await expect(seal(payload, "short", "session", 60)).rejects.toThrow(
			/at least 32/,
		);
	});
});

describe("cookie helpers", () => {
	it("serializes security attributes", () => {
		expect(serializeCookie("s", "v", { maxAge: 10, secure: true })).toBe(
			"s=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=10; Secure",
		);
		expect(
			serializeCookie("s", "v", { maxAge: 10, secure: false }),
		).not.toContain("Secure");
	});

	it("parses a Cookie header", () => {
		expect(parseCookies("a=1; b=x=y")).toEqual({ a: "1", b: "x=y" });
		expect(parseCookies(null)).toEqual({});
	});
});
