import { describe, expect, test } from "vitest";
import { parseSetCookies, serializeSetCookie } from "./cookies";

const roundTrip = (header: string) => {
	const [cookie] = parseSetCookies(header);
	return { cookie, serialized: serializeSetCookie(cookie) };
};

describe("Max-Age handling", () => {
	test("keeps a numeric Max-Age", () => {
		const { cookie, serialized } = roundTrip("a=b; Max-Age=3600");
		expect(cookie.maxAge).toBe(3600);
		expect(serialized).toContain("Max-Age=3600");
	});

	test("omits a non-numeric Max-Age instead of serializing NaN", () => {
		const { cookie, serialized } = roundTrip("a=b; Max-Age=soon");
		expect(cookie.maxAge).toBeUndefined();
		expect(serialized).not.toMatch(/Max-Age/i);
		expect(serialized).not.toContain("NaN");
	});

	test("preserves Max-Age=0 so sign-out can expire the cookie", () => {
		const { cookie, serialized } = roundTrip("a=b; Max-Age=0");
		expect(cookie.maxAge).toBe(0);
		expect(serialized).toContain("Max-Age=0");
	});
});
