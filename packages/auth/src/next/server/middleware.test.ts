import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { neonAuthMiddleware } from "./middleware";

const config = {
	baseUrl: "https://auth.example.com",
	cookies: { secret: "test-secret-at-least-32-characters-long!" },
};

const run = (
	pathname: string,
	extra: { publicRoutes?: string[]; loginUrl?: string } = {},
) =>
	neonAuthMiddleware({ ...config, ...extra })(
		new NextRequest(`https://app.example.com${pathname}`),
	);

describe("neonAuthMiddleware publicRoutes", () => {
	test("redirects a signed-out request to a non-default route to loginUrl", async () => {
		const response = await run("/pricing", { loginUrl: "/auth/sign-in" });
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://app.example.com/auth/sign-in",
		);
	});

	test("skips exact and nested custom public routes", async () => {
		for (const pathname of ["/pricing", "/pricing/team"]) {
			const response = await run(pathname, {
				publicRoutes: ["/pricing"],
			});
			expect(response.headers.get("location")).toBeNull();
			expect(response.headers.get("x-middleware-next")).toBe("1");
		}
	});

	test("still redirects unrelated routes and does not match on a shared prefix", async () => {
		for (const pathname of ["/dashboard", "/pricing-internal"]) {
			const response = await run(pathname, {
				publicRoutes: ["/pricing"],
			});
			expect(response.headers.get("location")).toBe(
				"https://app.example.com/auth/sign-in",
			);
		}
	});

	test("keeps the default skip routes when publicRoutes is set", async () => {
		const response = await run("/auth/reset-password", {
			publicRoutes: ["/pricing"],
		});
		expect(response.headers.get("location")).toBeNull();
	});
});
